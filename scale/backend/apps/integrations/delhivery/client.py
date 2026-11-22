"""
Delhivery API client (NDR actions).

SAFETY: this is the only place that talks to Delhivery. Tests MUST patch
`DelhiveryClient._post` (see tests/test_ndr_action.py). The base URL is env-configurable so a
staging host can be used: DELHIVERY_BASE_URL (default: production track.delhivery.com).

NOTE: endpoint/payload follow Delhivery's public NDR docs (`POST /api/p/update`,
`{"data": [{"waybill": ..., "act": "RE-ATTEMPT"}]}`) and have NOT been exercised against the live API.
"""
import os

import requests


class DelhiveryError(Exception):
    pass


class DelhiveryClient:
    def __init__(self, api_token: str):
        if not api_token:
            raise DelhiveryError("Delhivery API token is missing.")
        self.api_token = api_token
        self.base_url = os.environ.get("DELHIVERY_BASE_URL", "https://track.delhivery.com").rstrip("/")

    def _post(self, path: str, payload: dict) -> dict:
        resp = requests.post(
            f"{self.base_url}{path}",
            json=payload,
            headers={"Authorization": f"Token {self.api_token}", "Content-Type": "application/json"},
            timeout=15,
        )
        if resp.status_code >= 400:
            raise DelhiveryError(f"Delhivery returned HTTP {resp.status_code}")
        return resp.json()

    def reattempt(self, waybill: str) -> dict:
        return self._post("/api/p/update", {"data": [{"waybill": waybill, "act": "RE-ATTEMPT"}]})
