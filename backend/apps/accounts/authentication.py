"""
Authentication for the API: Django server-side sessions only.

The browser holds a single HTTP-only `sessionid` cookie. There are no bearer tokens: an `Authorization`
header is ignored, so no token can be stolen from JavaScript-readable storage.
"""
from rest_framework import authentication

SAFE_METHODS = ("GET", "HEAD", "OPTIONS", "TRACE")


class SessionAuthentication(authentication.SessionAuthentication):
    """
    DRF session authentication that answers unauthenticated requests with 401 instead of 403,
    so the frontend can tell "not signed in / session expired" apart from "signed in but not allowed".
    """

    def authenticate_header(self, request):
        return 'Session realm="api"'


def enforce_csrf(request) -> None:
    """
    Run Django's CSRF check on a request even when nobody is logged in yet.

    DRF only checks CSRF for already-authenticated sessions; login and registration also need it,
    otherwise a third-party page could sign a victim into an attacker-controlled account (login CSRF).
    """
    authentication.SessionAuthentication().enforce_csrf(request)


class CsrfProtectedMixin:
    """For AllowAny views reached before a session exists (register, login, MFA challenge, password reset)."""

    def initial(self, request, *args, **kwargs):
        super().initial(request, *args, **kwargs)
        if request.method not in SAFE_METHODS:
            enforce_csrf(request)  # raises PermissionDenied (403) when the token is missing or wrong
