"""
Inbound webhook security, parametrized over Shopify, Razorpay, Shiprocket and Meta.

Real Django stack, real Postgres, real HMAC maths; no network. Every request is sent with CSRF enforcement on, because
providers cannot send CSRF tokens: the signature is the only authentication. Celery is intercepted at
`process_webhook_event_task.apply_async`, so we see exactly what would be handed to a worker and when.

Contract these tests assume where the application has no implementation yet (routes for Shiprocket and Meta do not exist
at the time of writing; Shopify and Razorpay process inline instead of enqueueing):
  * POST /api/webhooks/{shopify|razorpay|shiprocket|meta}/<brand uuid>/ ; the URL carries the brand, the integration is
    the brand's integration of that provider. GET on the Meta URL is the hub.challenge handshake.
  * a valid delivery stores a WebhookEvent and enqueues `process_webhook_event_task(<WebhookEvent.id>)` from
    `transaction.on_commit`, never before the row is committed
  * credential keys (stored encrypted): shopify api_secret | razorpay webhook_secret | shiprocket webhook_token
    (sent verbatim in `X-Api-Key`) | meta app_secret + verify_token
  * 401 bad/missing authentication, 404 unknown / mismatched / disconnected integration, 413 body over 1 MiB,
    400 malformed JSON (checked only after the signature), 403 failed Meta handshake, 401 for a Shopify shop-domain
    mismatch
  * event dedupe is per brand: the same event id arriving for two tenants is two events
"""
import ast
import base64
import hashlib
import hmac
import json
import logging
import re
import secrets
import time
import uuid
from pathlib import Path
from statistics import median
from types import SimpleNamespace
from unittest import mock

import pytest
import requests
from apps.commerce.models import Order, PaymentAttempt, Shipment
from apps.integrations.crypto import encrypt_credentials
from apps.integrations.models import Integration, RawPayload, WebhookEvent
from apps.integrations.tasks import process_webhook_event_task
from apps.tenancy.models import Brand
from django.conf import settings
from django.test import Client

pytestmark = pytest.mark.django_db

MAX_BODY = 1024 * 1024  # 1 MiB
SIZE_OVER_LIMIT = MAX_BODY + 64 * 1024  # clearly over, whichever of 1 MB / 1 MiB the implementation uses
SIZE_UNDER_LIMIT = 900 * 1000  # clearly under both
MARKER = b"ABCDEF"


# ---------------------------------------------------------------------------
# Providers
# ---------------------------------------------------------------------------
class Spec:
    slug: str                      # URL segment
    db_provider: str               # Integration.provider
    event_providers: tuple         # accepted values for WebhookEvent.provider
    body_signed = True             # does the credential authenticate the body (HMAC) or only the sender (token)?
    event_id_header: str | None = None  # META key of the provider's own delivery/event id, if it has one

    def secret(self, tenant):
        return f"{tenant.lower()}-secret-{self.slug}"

    def domain(self, tenant):
        return ""

    def creds(self, tenant):
        raise NotImplementedError

    def sign(self, body: bytes, secret: str) -> dict:
        raise NotImplementedError

    def headers(self, n, tenant) -> dict:
        return {}

    def payload(self, n) -> dict:
        raise NotImplementedError

    def body(self, n=1) -> bytes:
        return json.dumps({**self.payload(n), "marker": MARKER.decode()}, sort_keys=True).encode()

    def body_of_size(self, size, n=1) -> bytes:
        obj = {**self.payload(n), "marker": MARKER.decode()}
        base = len(json.dumps({**obj, "pad": ""}).encode())
        return json.dumps({**obj, "pad": "x" * (size - base)}).encode()

    def request(self, n=1, tenant="A", body=None, secret=None):
        body = self.body(n) if body is None else body
        secret = self.secret(tenant) if secret is None else secret
        return body, {**self.headers(n, tenant), **self.sign(body, secret)}

    def __repr__(self):
        return self.slug


class Shopify(Spec):
    slug, db_provider, event_providers = "shopify", "shopify", ("shopify",)
    event_id_header = "HTTP_X_SHOPIFY_WEBHOOK_ID"

    def domain(self, tenant):
        return f"{tenant.lower()}-shop.myshopify.com"

    def creds(self, tenant):
        return {"api_secret": self.secret(tenant), "shop_domain": self.domain(tenant)}

    def sign(self, body, secret):
        digest = hmac.new(secret.encode(), body, hashlib.sha256).digest()
        return {"HTTP_X_SHOPIFY_HMAC_SHA256": base64.b64encode(digest).decode()}

    def headers(self, n, tenant):
        return {
            "HTTP_X_SHOPIFY_TOPIC": "orders/create",
            "HTTP_X_SHOPIFY_WEBHOOK_ID": f"wh-{n}",
            "HTTP_X_SHOPIFY_SHOP_DOMAIN": self.domain(tenant),
        }

    def payload(self, n):
        return {
            "id": 5551000 + n, "order_number": 1000 + n, "name": f"#{1000 + n}", "currency": "INR",
            "total_line_items_price": "1499.00", "total_discounts": "0.00", "total_tax": "0.00",
            "financial_status": "paid", "fulfillment_status": None,
            "created_at": "2026-11-01T10:00:00+05:30", "updated_at": "2026-11-01T10:05:00+05:30",
            "line_items": [{"id": 1, "title": "Ring", "quantity": 1, "price": "1499.00"}],
        }


class Razorpay(Spec):
    slug, db_provider, event_providers = "razorpay", "razorpay", ("razorpay",)
    event_id_header = "HTTP_X_RAZORPAY_EVENT_ID"

    def creds(self, tenant):
        return {"webhook_secret": self.secret(tenant)}

    def sign(self, body, secret):
        return {"HTTP_X_RAZORPAY_SIGNATURE": hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()}

    def headers(self, n, tenant):
        return {"HTTP_X_RAZORPAY_EVENT_ID": f"evt_{n}"}

    def payload(self, n):
        return {
            "event": "payment.captured",
            "payload": {"payment": {"entity": {
                "id": f"pay_{n:06d}", "amount": 149900, "currency": "INR", "status": "captured",
                "method": "upi", "order_id": f"order_{n}", "created_at": 1790000000,
            }}},
        }


class Shiprocket(Spec):
    slug, db_provider, event_providers = "shiprocket", "shiprocket", ("shiprocket",)
    body_signed = False  # a static token proves who is calling, not what they sent

    def creds(self, tenant):
        return {"webhook_token": self.secret(tenant)}

    def sign(self, body, secret):
        return {"HTTP_X_API_KEY": secret}

    def payload(self, n):
        return {"awb": f"SR{n:08d}", "current_status": "DELIVERED", "current_status_id": 7, "order_id": f"ORD-{n}"}


class Meta(Spec):
    slug, db_provider, event_providers = "meta", "meta_ads", ("meta", "meta_ads")

    def verify_token(self, tenant):
        return f"{tenant.lower()}-verify-token"

    def creds(self, tenant):
        return {"app_secret": self.secret(tenant), "verify_token": self.verify_token(tenant)}

    def sign(self, body, secret):
        return {"HTTP_X_HUB_SIGNATURE_256": "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()}

    def payload(self, n):
        return {"object": "ad_account", "entry": [{"id": "act_1", "time": 1790000000 + n,
                                                    "changes": [{"field": "campaign", "value": {"n": n}}]}]}


SHOPIFY, RAZORPAY, SHIPROCKET, META = Shopify(), Razorpay(), Shiprocket(), Meta()
PROVIDERS = [SHOPIFY, RAZORPAY, SHIPROCKET, META]
BODY_SIGNED = [s for s in PROVIDERS if s.body_signed]
with_provider = pytest.mark.parametrize("spec", PROVIDERS, ids=lambda s: s.slug)
with_body_signed_provider = pytest.mark.parametrize("spec", BODY_SIGNED, ids=lambda s: s.slug)


def url(spec, brand_id):
    return f"/api/webhooks/{spec.slug}/{brand_id}/"


# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------
@pytest.fixture(autouse=True)
def _no_live_calls():
    with (
        mock.patch.object(requests.sessions.Session, "request", side_effect=AssertionError("network call attempted")),
        mock.patch("urllib.request.urlopen", side_effect=AssertionError("network call attempted")),
    ):
        yield


@pytest.fixture(autouse=True)
def enqueued():
    """Everything handed to Celery. Mocking apply_async catches both .delay() and .apply_async()."""
    with mock.patch.object(process_webhook_event_task, "apply_async") as m:
        yield m


def enqueued_event_ids(m):
    ids = []
    for call in m.call_args_list:
        args = call.kwargs.get("args") or (call.args[0] if call.args else ())
        ids.append(str(args[0]))
    return ids


def connect(workspace, brand, spec, tenant, **overrides):
    fields = {
        "workspace": workspace, "brand": brand, "provider": spec.db_provider, "status": "connected",
        "account_identifier": spec.domain(tenant), "encrypted_credentials": encrypt_credentials(spec.creds(tenant)),
    }
    return Integration.objects.create(**{**fields, **overrides})


@pytest.fixture
def tenants(workspace_a, brand_a, workspace_b, brand_b):
    """Both tenants have a connected integration for every provider, each with its own secrets."""
    return SimpleNamespace(
        a=brand_a, b=brand_b,
        integrations={
            (spec.slug, tenant): connect(ws, brand, spec, tenant)
            for spec in PROVIDERS
            for tenant, ws, brand in (("A", workspace_a, brand_a), ("B", workspace_b, brand_b))
        },
    )


@pytest.fixture
def send(django_capture_on_commit_callbacks):
    """POST a delivery. on_commit callbacks are captured, and run after the request unless run_commit=False."""

    def _send(spec, brand, body, headers, *, run_commit=True):
        with django_capture_on_commit_callbacks(execute=False) as callbacks:
            start = time.perf_counter()
            res = Client(enforce_csrf_checks=True).post(
                url(spec, brand.id), data=body, content_type="application/json", **headers
            )
            elapsed = time.perf_counter() - start
        if run_commit:
            for callback in callbacks:
                callback()
        return SimpleNamespace(res=res, elapsed=elapsed, callbacks=callbacks)

    return _send


def stored():
    """Everything an inbound webhook could have persisted."""
    return (
        WebhookEvent.objects.count(), Order.objects.count(), PaymentAttempt.objects.count(),
        Shipment.objects.count(), RawPayload.objects.count(),
    )


def warnings_for(caplog, spec):
    """WARNINGs the application chose to log. Django's own `django.request` 4xx line does not count."""
    return [
        r for r in caplog.records
        if r.levelno == logging.WARNING and not r.name.startswith("django.")
        and "webhook" in r.getMessage().lower() and spec.slug in r.getMessage().lower()
    ]


# ---------------------------------------------------------------------------
# 1. Valid delivery
# ---------------------------------------------------------------------------
class TestValidDelivery:
    @with_provider
    def test_stored_and_enqueued_only_after_commit(self, spec, tenants, send, enqueued, workspace_a, brand_a):
        body, headers = spec.request(1)

        out = send(spec, brand_a, body, headers, run_commit=False)

        assert out.res.status_code == 200, out.res.content
        event = WebhookEvent.objects.get()
        assert (event.workspace_id, event.brand_id) == (workspace_a.id, brand_a.id)
        assert event.provider in spec.event_providers
        assert event.raw_body == body.decode()
        enqueued.assert_not_called()  # the row is not committed yet: a worker must not be able to race it

        for callback in out.callbacks:  # COMMIT
            callback()
        assert enqueued_event_ids(enqueued) == [str(event.id)]

    @with_provider
    def test_responds_within_200ms(self, spec, tenants, send, brand_a):
        send(spec, brand_a, *spec.request(0))  # warm-up: imports, connection, query plans
        timings = []
        for n in range(1, 6):
            out = send(spec, brand_a, *spec.request(n))
            assert out.res.status_code == 200, out.res.content
            timings.append(out.elapsed)
        assert median(timings) < 0.2, f"median {median(timings) * 1000:.0f}ms, all: {[round(t * 1000) for t in timings]}"

    @with_provider
    def test_credentials_and_signatures_are_not_persisted(self, spec, tenants, send, brand_a):
        body, headers = spec.request(1)
        send(spec, brand_a, body, headers)
        event = WebhookEvent.objects.get()
        blob = (json.dumps(event.headers) + event.raw_body + event.error).lower()
        for name, value in headers.items():
            if "SIGNATURE" in name or "API_KEY" in name or "HMAC" in name:
                assert value.lower() not in blob, f"{name} value was persisted"
        assert spec.secret("A").lower() not in blob

    @with_body_signed_provider
    def test_signature_covers_the_raw_bytes_not_the_parsed_json(self, spec, tenants, send, brand_a):
        """Whitespace/ordering/unicode differences must not matter: the HMAC is over exactly what was sent."""
        obj = json.loads(spec.body(1))
        raw = json.dumps({**obj, "note": "₹ café"}, indent=3, ensure_ascii=False, sort_keys=False).encode("utf-8")
        out = send(spec, brand_a, *spec.request(1, body=raw))
        assert out.res.status_code == 200, out.res.content

    @with_provider
    def test_works_with_csrf_enforcement_on(self, spec, tenants, send, brand_a):
        """`send` enforces CSRF; providers cannot send tokens, so webhook routes must be exempt."""
        assert send(spec, brand_a, *spec.request(1)).res.status_code == 200


# ---------------------------------------------------------------------------
# 2. Authentication failures
# ---------------------------------------------------------------------------
REJECTIONS = [
    (spec, case)
    for spec in PROVIDERS
    for case in ("missing", "wrong_secret", "other_tenant_secret", "tampered")
    if not (case == "tampered" and not spec.body_signed)
]


def sig_values(headers):
    return [v for k, v in headers.items() if "SIGNATURE" in k or "API_KEY" in k or "HMAC" in k]


class TestRejectedAuthentication:
    @pytest.mark.parametrize(("spec", "case"), REJECTIONS, ids=[f"{s.slug}-{c}" for s, c in REJECTIONS])
    def test_401_nothing_stored_warning_logged(self, spec, case, tenants, send, enqueued, caplog, brand_a, brand_b):
        caplog.set_level(logging.DEBUG)
        body, headers = spec.request(1)
        if case == "missing":
            headers = {k: v for k, v in headers.items() if k not in spec.sign(body, "x")}
        elif case == "wrong_secret":
            body, headers = spec.request(1, secret="attacker-secret")
        elif case == "other_tenant_secret":
            body, headers = spec.request(1, secret=spec.secret("B"))
        elif case == "tampered":
            tampered = body.replace(MARKER, MARKER[:-1] + b"G")
            assert len(tampered) == len(body) and sum(x != y for x, y in zip(body, tampered, strict=True)) == 1
            body = tampered  # headers still carry the signature of the original body

        out = send(spec, brand_a, body, headers)

        assert out.res.status_code == 401, f"{spec.slug}/{case}: {out.res.status_code} {out.res.content[:200]}"
        assert stored() == (0, 0, 0, 0, 0)
        enqueued.assert_not_called()
        assert warnings_for(caplog, spec), f"no WARNING mentioning the {spec.slug} webhook was logged"
        for leaked in [spec.secret("A"), spec.secret("B"), *sig_values(headers)]:
            assert leaked not in caplog.text, "a secret or signature was written to the logs"

        # Control: tenant B's own credentials do work on B's own URL, so the 401 above is not a broken fixture.
        assert send(spec, brand_b, *spec.request(1, tenant="B")).res.status_code == 200

    @with_provider
    def test_integration_without_a_secret_rejects_everything(self, spec, tenants, send, enqueued, brand_a):
        """An empty stored secret must never validate an empty/empty-keyed signature."""
        Integration.objects.filter(brand=brand_a, provider=spec.db_provider).update(
            encrypted_credentials=encrypt_credentials({"unrelated": "x"})
        )
        body, headers = spec.request(1, secret="")
        out = send(spec, brand_a, body, headers)
        assert out.res.status_code == 401, out.res.content
        assert stored() == (0, 0, 0, 0, 0)
        enqueued.assert_not_called()

    @with_body_signed_provider
    def test_signature_is_checked_before_the_body_is_parsed(self, spec, tenants, send, brand_a):
        """Malformed JSON with a bad signature must be 401, not 400 (no parser oracle for unauthenticated callers)."""
        body, headers = spec.request(1, body=b'{"truncated": ', secret="attacker-secret")
        assert send(spec, brand_a, body, headers).res.status_code == 401


# ---------------------------------------------------------------------------
# 3. Replay / idempotency
# ---------------------------------------------------------------------------
class TestReplay:
    @with_provider
    def test_same_event_twice_is_200_but_stored_and_processed_once(self, spec, tenants, send, enqueued, brand_a):
        body, headers = spec.request(1)
        first = send(spec, brand_a, body, headers)
        # apply_async is mocked, so simulate the worker having finished the first delivery.
        # (An event that is still unprocessed IS re-enqueued on redelivery: see the next test.)
        WebhookEvent.objects.update(processed=True)
        second = send(spec, brand_a, body, headers)

        assert (first.res.status_code, second.res.status_code) == (200, 200), (first.res.content, second.res.content)
        assert WebhookEvent.objects.count() == 1
        assert len(enqueued_event_ids(enqueued)) == 1, "a replayed event was processed again"
        assert second.res.json().get("status") == "duplicate"

    @with_provider
    def test_redelivery_of_an_unprocessed_event_is_reenqueued_not_dropped(self, spec, tenants, send, enqueued, brand_a):
        """QA 2026-11-21: if processing of the first delivery failed, the provider's retry must re-run it.
        Re-running is safe: processing skips processed events and ingest is upsert-based."""
        body, headers = spec.request(1)
        send(spec, brand_a, body, headers)
        second = send(spec, brand_a, body, headers)
        assert second.res.status_code == 200
        assert second.res.json().get("status") == "retrying"
        assert WebhookEvent.objects.count() == 1, "a redelivery must not create a second event row"
        ids = enqueued_event_ids(enqueued)
        assert len(ids) == 2 and len(set(ids)) == 1, "the SAME stored event is re-enqueued"

    @pytest.mark.parametrize("spec", [s for s in PROVIDERS if s.event_id_header], ids=lambda s: s.slug)
    def test_provider_event_id_header_is_the_dedupe_key(self, spec, tenants, send, enqueued, brand_a):
        same_id_other_body = [spec.request(1), spec.request(2)]
        same_id_other_body[1][1][spec.event_id_header] = same_id_other_body[0][1][spec.event_id_header]
        for body, headers in same_id_other_body:
            assert send(spec, brand_a, body, headers).res.status_code == 200
            WebhookEvent.objects.update(processed=True)  # worker finished (apply_async is mocked)
        assert WebhookEvent.objects.count() == 1 and len(enqueued.call_args_list) == 1

    @pytest.mark.parametrize("spec", [s for s in PROVIDERS if s.event_id_header], ids=lambda s: s.slug)
    def test_different_event_ids_are_different_events(self, spec, tenants, send, enqueued, brand_a):
        body, headers = spec.request(1)
        other_headers = {**headers, spec.event_id_header: "a-different-delivery-id"}
        for hdrs in (headers, other_headers):
            assert send(spec, brand_a, body, hdrs).res.status_code == 200
        assert WebhookEvent.objects.count() == 2 and len(enqueued.call_args_list) == 2

    @with_provider
    def test_dedupe_is_per_tenant(self, spec, tenants, send, enqueued, brand_a, brand_b):
        """Tenant B sending an event id/body tenant A also uses must not suppress, or be suppressed by, A's event."""
        for tenant, brand in (("A", brand_a), ("B", brand_b)):
            out = send(spec, brand, *spec.request(1, tenant=tenant))
            assert out.res.status_code == 200 and out.res.json().get("status") != "duplicate", out.res.content
        assert sorted(WebhookEvent.objects.values_list("brand_id", flat=True)) == sorted([brand_a.id, brand_b.id])
        assert len(enqueued.call_args_list) == 2


# ---------------------------------------------------------------------------
# 4. Routing: unknown / mismatched / disconnected -> 404
# ---------------------------------------------------------------------------
class TestRouting:
    def delivery_is_accepted_normally(self, spec, send, brand):
        """Control: the same URL scheme and credentials work when pointed at the right place."""
        out = send(spec, brand, *spec.request(99))
        assert out.res.status_code == 200, f"control failed, so a 404 elsewhere proves nothing: {out.res.status_code}"
        return stored()

    @with_provider
    def test_unknown_uuid_is_404(self, spec, tenants, send, enqueued, brand_a):
        baseline = self.delivery_is_accepted_normally(spec, send, brand_a)
        enqueued.reset_mock()

        ghost = SimpleNamespace(id=uuid.uuid4())
        out = send(spec, ghost, *spec.request(1))

        assert out.res.status_code == 404, out.res.content
        assert stored() == baseline
        enqueued.assert_not_called()

    @with_provider
    def test_provider_mismatch_is_404(self, spec, tenants, send, enqueued, workspace_a, brand_a):
        """A brand whose only integration is another provider's must not answer this provider's URL, even when the
        request is validly signed with a credential that integration happens to hold."""
        baseline = self.delivery_is_accepted_normally(spec, send, brand_a)
        enqueued.reset_mock()

        other = PROVIDERS[(PROVIDERS.index(spec) + 1) % len(PROVIDERS)]
        decoy_brand = Brand.objects.create(workspace=workspace_a, name="Decoy")
        superset = {k: v for s in PROVIDERS for k, v in s.creds("A").items()}
        Integration.objects.create(
            workspace=workspace_a, brand=decoy_brand, provider=other.db_provider, status="connected",
            account_identifier=spec.domain("A"), encrypted_credentials=encrypt_credentials(superset),
        )

        out = send(spec, decoy_brand, *spec.request(1))

        assert out.res.status_code == 404, out.res.content
        assert stored() == baseline
        enqueued.assert_not_called()

    @with_provider
    def test_brand_without_any_integration_is_404(self, spec, tenants, send, workspace_a, brand_a):
        self.delivery_is_accepted_normally(spec, send, brand_a)
        bare = Brand.objects.create(workspace=workspace_a, name="Bare")
        assert send(spec, bare, *spec.request(1)).res.status_code == 404

    @pytest.mark.parametrize("wipe_credentials", [False, True], ids=["secret-retained", "credentials-wiped"])
    @with_provider
    def test_disconnected_integration_is_404(self, spec, wipe_credentials, tenants, send, enqueued, brand_a):
        baseline = self.delivery_is_accepted_normally(spec, send, brand_a)
        enqueued.reset_mock()
        changes = {"status": Integration.Status.DISCONNECTED}
        if wipe_credentials:
            changes["encrypted_credentials"] = b""  # what DELETE .../integrations/ does
        Integration.objects.filter(brand=brand_a, provider=spec.db_provider).update(**changes)

        out = send(spec, brand_a, *spec.request(2))  # correctly signed with the (possibly still stored) secret

        assert out.res.status_code == 404, f"disconnected {spec.slug} still answers: {out.res.status_code}"
        assert stored() == baseline
        enqueued.assert_not_called()


# ---------------------------------------------------------------------------
# 5. Body size and shape
# ---------------------------------------------------------------------------
class TestBodyHandling:
    @with_provider
    def test_body_over_1mb_is_413_even_when_correctly_signed(self, spec, tenants, send, enqueued, brand_a):
        body = spec.body_of_size(SIZE_OVER_LIMIT)
        assert len(body) > MAX_BODY
        out = send(spec, brand_a, *spec.request(1, body=body))
        assert out.res.status_code == 413, out.res.status_code
        assert stored() == (0, 0, 0, 0, 0)
        enqueued.assert_not_called()

    @with_provider
    def test_large_body_under_the_limit_is_accepted(self, spec, tenants, send, brand_a):
        """Control: the 413 above is about size, not about big bodies being unparseable."""
        out = send(spec, brand_a, *spec.request(1, body=spec.body_of_size(SIZE_UNDER_LIMIT)))
        assert out.res.status_code == 200, out.res.status_code

    @with_provider
    def test_invalid_json_with_valid_signature_is_400(self, spec, tenants, send, enqueued, brand_a):
        out = send(spec, brand_a, *spec.request(1, body=b'{"event": "payment.captured", "payload": '))
        assert out.res.status_code == 400, f"{out.res.status_code} {out.res.content[:200]}"
        assert stored() == (0, 0, 0, 0, 0)
        enqueued.assert_not_called()

    @with_provider
    def test_non_object_json_is_400(self, spec, tenants, send, brand_a):
        assert send(spec, brand_a, *spec.request(1, body=b"[1, 2, 3]")).res.status_code == 400


# ---------------------------------------------------------------------------
# 6. Provider specifics
# ---------------------------------------------------------------------------
class TestShopify:
    @pytest.mark.parametrize("domain", ["evil-shop.myshopify.com", "A-SHOP.myshopify.com.evil.test", None],
                             ids=["other-shop", "suffix-trick", "missing"])
    def test_shop_domain_must_match_the_integration(self, domain, tenants, send, enqueued, brand_a):
        body, headers = SHOPIFY.request(1)  # valid HMAC
        if domain is None:
            del headers["HTTP_X_SHOPIFY_SHOP_DOMAIN"]
        else:
            headers["HTTP_X_SHOPIFY_SHOP_DOMAIN"] = domain
        out = send(SHOPIFY, brand_a, body, headers)
        assert out.res.status_code == 401, out.res.content
        assert stored() == (0, 0, 0, 0, 0)
        enqueued.assert_not_called()
        assert send(SHOPIFY, brand_a, *SHOPIFY.request(1)).res.status_code == 200  # control: the right domain works

    def test_signature_must_be_base64_not_hex(self, tenants, send, brand_a):
        body, headers = SHOPIFY.request(1)
        digest = hmac.new(SHOPIFY.secret("A").encode(), body, hashlib.sha256)
        assert send(SHOPIFY, brand_a, body, {**headers, "HTTP_X_SHOPIFY_HMAC_SHA256": digest.hexdigest()}).res.status_code == 401
        b64 = base64.b64encode(digest.digest()).decode()
        assert send(SHOPIFY, brand_a, body, {**headers, "HTTP_X_SHOPIFY_HMAC_SHA256": b64}).res.status_code == 200


class TestRazorpay:
    def test_signature_must_be_hex_not_base64(self, tenants, send, brand_a):
        body, headers = RAZORPAY.request(1)
        digest = hmac.new(RAZORPAY.secret("A").encode(), body, hashlib.sha256)
        b64 = base64.b64encode(digest.digest()).decode()
        assert send(RAZORPAY, brand_a, body, {**headers, "HTTP_X_RAZORPAY_SIGNATURE": b64}).res.status_code == 401
        assert send(RAZORPAY, brand_a, body, {**headers, "HTTP_X_RAZORPAY_SIGNATURE": digest.hexdigest()}).res.status_code == 200


class TestShiprocket:
    @pytest.mark.parametrize("token", ["TOKEN+", "token ", " token", "token-longer", "tok", ""],
                             ids=["case", "trailing-space", "leading-space", "prefix-extension", "prefix", "empty"])
    def test_token_must_match_exactly(self, token, tenants, send, enqueued, brand_a):
        creds = SHIPROCKET.creds("A")
        Integration.objects.filter(brand=brand_a, provider="shiprocket").update(
            encrypted_credentials=encrypt_credentials({"webhook_token": "token"})
        )
        assert creds  # fixture sanity
        out = send(SHIPROCKET, brand_a, *SHIPROCKET.request(1, secret=token))
        assert out.res.status_code == 401, out.res.content
        enqueued.assert_not_called()
        assert send(SHIPROCKET, brand_a, *SHIPROCKET.request(1, secret="token")).res.status_code == 200  # control

    def test_token_in_query_string_or_body_is_not_accepted(self, tenants, send, brand_a):
        body, _ = SHIPROCKET.request(1)
        res = Client().post(
            url(SHIPROCKET, brand_a.id) + f"?token={SHIPROCKET.secret('A')}&x-api-key={SHIPROCKET.secret('A')}",
            data=body, content_type="application/json",
        )
        assert res.status_code == 401


class TestMetaPost:
    @pytest.mark.parametrize("variant", ["no_prefix", "sha1_prefix", "legacy_sha1_header", "uppercase_prefix"])
    def test_signature_format_is_strict(self, variant, tenants, send, enqueued, brand_a):
        body, headers = META.request(1)
        hexdigest = hmac.new(META.secret("A").encode(), body, hashlib.sha256).hexdigest()
        headers = {
            "no_prefix": {"HTTP_X_HUB_SIGNATURE_256": hexdigest},
            "sha1_prefix": {"HTTP_X_HUB_SIGNATURE_256": "sha1=" + hexdigest},
            "legacy_sha1_header": {"HTTP_X_HUB_SIGNATURE": "sha1=" + hmac.new(
                META.secret("A").encode(), body, hashlib.sha1).hexdigest()},
            "uppercase_prefix": {"HTTP_X_HUB_SIGNATURE_256": "SHA256=" + hexdigest},
        }[variant]
        out = send(META, brand_a, body, headers)
        assert out.res.status_code == 401, out.res.content
        enqueued.assert_not_called()

    def test_verify_token_is_not_a_post_credential(self, tenants, send, enqueued, brand_a):
        body, _ = META.request(1)
        out = send(META, brand_a, body, {"HTTP_X_HUB_SIGNATURE_256": "sha256=" + META.verify_token("A")})
        assert out.res.status_code == 401
        enqueued.assert_not_called()


class TestMetaHandshake:
    CHALLENGE = "1158201444"

    def get(self, brand_id, **params):
        query = {"hub.mode": "subscribe", "hub.challenge": self.CHALLENGE, **params}
        return Client().get(url(META, brand_id), {k.replace("__", "."): v for k, v in query.items() if v is not None})

    def test_correct_verify_token_echoes_the_challenge_verbatim(self, tenants, brand_a):
        res = self.get(brand_a.id, hub__verify_token=META.verify_token("A"))
        assert res.status_code == 200, res.content
        assert res.content.decode() == self.CHALLENGE  # bare text: Meta rejects a JSON-quoted echo
        assert "json" not in res["Content-Type"]
        assert stored() == (0, 0, 0, 0, 0)

    @pytest.mark.parametrize("token", ["wrong-token", "", None, "B-TOKEN", "b-verify-token"],
                             ids=["wrong", "empty", "missing", "case-variant", "other-tenant"])
    def test_anything_else_is_refused(self, token, tenants, brand_a):
        res = self.get(brand_a.id, hub__verify_token=token)
        assert res.status_code == 403, res.status_code
        assert self.CHALLENGE not in res.content.decode()
        # control: the same URL answers the handshake when the token is right
        assert self.get(brand_a.id, hub__verify_token=META.verify_token("A")).status_code == 200

    def test_integration_without_verify_token_never_validates(self, tenants, brand_a):
        Integration.objects.filter(brand=brand_a, provider="meta_ads").update(
            encrypted_credentials=encrypt_credentials({"app_secret": META.secret("A")})
        )
        for token in ("", None, "None"):
            res = self.get(brand_a.id, hub__verify_token=token)
            assert res.status_code == 403 and self.CHALLENGE not in res.content.decode(), token

    def test_only_the_subscribe_mode_is_answered(self, tenants, brand_a):
        assert self.get(brand_a.id, hub__verify_token=META.verify_token("A")).status_code == 200  # control
        res = self.get(brand_a.id, hub__verify_token=META.verify_token("A"), hub__mode="unsubscribe")
        assert res.status_code != 200 and self.CHALLENGE not in res.content.decode()

    def test_unknown_uuid_is_404(self, tenants, brand_a):
        assert self.get(brand_a.id, hub__verify_token=META.verify_token("A")).status_code == 200  # control
        assert self.get(uuid.uuid4(), hub__verify_token=META.verify_token("A")).status_code == 404

    def test_disconnected_integration_is_404(self, tenants, brand_a):
        assert self.get(brand_a.id, hub__verify_token=META.verify_token("A")).status_code == 200  # control
        Integration.objects.filter(brand=brand_a, provider="meta_ads").update(status="disconnected")
        res = self.get(brand_a.id, hub__verify_token=META.verify_token("A"))
        assert res.status_code == 404 and self.CHALLENGE not in res.content.decode()

    @pytest.mark.parametrize("spec", [s for s in PROVIDERS if s is not META], ids=lambda s: s.slug)
    def test_other_providers_do_not_answer_the_handshake(self, spec, tenants, brand_a):
        res = Client().get(url(spec, brand_a.id), {"hub.mode": "subscribe", "hub.challenge": self.CHALLENGE,
                                                    "hub.verify_token": META.verify_token("A")})
        assert res.status_code == 405 and self.CHALLENGE not in res.content.decode()


# ---------------------------------------------------------------------------
# 7. Constant-time comparison
# ---------------------------------------------------------------------------
SENSITIVE_NAME = re.compile(r"sig|hmac|digest|secret|verify_token|challenge|api_key|webhook_token|\btoken\b", re.I)


def insecure_comparisons(source: str, filename="<src>"):
    """(line, code) for every ==/!= whose operands look like a signature, token or secret."""
    found = []
    for node in ast.walk(ast.parse(source, filename)):
        if not isinstance(node, ast.Compare) or not any(isinstance(op, ast.Eq | ast.NotEq) for op in node.ops):
            continue
        operands = [node.left, *node.comparators]
        if any(isinstance(o, ast.Constant) and (o.value is None or isinstance(o.value, bool | int) or o.value == "")
               for o in operands):
            continue  # `x == None`, `status == 200`, `secret == ""` leak nothing
        code = ast.unparse(node)
        if SENSITIVE_NAME.search(code):
            found.append((node.lineno, code))
    return found


def webhook_sources():
    apps_dir = Path(settings.BASE_DIR) / "apps"
    for path in sorted(apps_dir.rglob("*.py")):
        if "migrations" in path.parts:
            continue
        text = path.read_text(encoding="utf-8")
        if re.search(r"webhook|hub_signature|verify_webhook", text, re.I):
            yield path, text


class TestConstantTimeComparison:
    def test_detector_flags_equality_and_accepts_compare_digest(self):
        """Guards the guard: the scanner below must actually be able to fail."""
        assert insecure_comparisons("if signature == expected: pass")
        assert insecure_comparisons("ok = hmac_header != calculated_hmac")
        assert insecure_comparisons("if request.GET.get('hub.verify_token') == creds['verify_token']: pass")
        assert insecure_comparisons("if x_api_key == token: pass")
        assert not insecure_comparisons("ok = hmac.compare_digest(signature, expected)")
        assert not insecure_comparisons("if provider == 'shopify': pass")
        assert not insecure_comparisons("if secret == '': pass")

    def test_no_webhook_code_compares_signatures_or_tokens_with_equality(self):
        sources = list(webhook_sources())
        assert sources, "found no webhook code to scan"
        offenders = [
            f"{path.relative_to(settings.BASE_DIR)}:{line}: {code}"
            for path, text in sources
            for line, code in insecure_comparisons(text, str(path))
        ]
        assert not offenders, "non-constant-time comparison of a secret/signature:\n" + "\n".join(offenders)

    @with_provider
    def test_verification_goes_through_compare_digest(self, spec, tenants, send, brand_a):
        """Behavioural twin of the grep: a delivery's credential check must reach a constant-time comparison."""
        with (
            mock.patch("hmac.compare_digest", wraps=hmac.compare_digest) as via_hmac,
            mock.patch("secrets.compare_digest", wraps=secrets.compare_digest) as via_secrets,
        ):
            assert send(spec, brand_a, *spec.request(1)).res.status_code == 200
        assert via_hmac.called or via_secrets.called, f"{spec.slug}: credentials were not compared with compare_digest"

    def test_meta_handshake_token_goes_through_compare_digest(self, tenants, brand_a):
        with (
            mock.patch("hmac.compare_digest", wraps=hmac.compare_digest) as via_hmac,
            mock.patch("secrets.compare_digest", wraps=secrets.compare_digest) as via_secrets,
        ):
            res = TestMetaHandshake().get(brand_a.id, hub__verify_token=META.verify_token("A"))
        assert res.status_code == 200
        assert via_hmac.called or via_secrets.called, "verify_token was not compared with compare_digest"
