from django.urls import re_path

from .views import (
    CsrfView,
    LoginView,
    LogoutView,
    MeView,
    MFAChallengeView,
    MFAConfirmView,
    MFADisableView,
    MFARecoveryLoginView,
    MFARecoveryRegenerateView,
    MFASetupView,
    MFAStatusView,
    MFAVerifyView,
    PasswordResetConfirmView,
    PasswordResetRequestView,
    RegisterView,
)

# Standard auth endpoints mounted at /api/auth/ or /api/v1/auth/
urlpatterns = [
    re_path(r"^csrf/?$", CsrfView.as_view(), name="auth-csrf"),
    re_path(r"^register/?$", RegisterView.as_view(), name="auth-register"),
    re_path(r"^login/?$", LoginView.as_view(), name="auth-login"),
    re_path(r"^password-reset/?$", PasswordResetRequestView.as_view(), name="auth-password-reset"),
    re_path(r"^password-reset/confirm/?$", PasswordResetConfirmView.as_view(), name="auth-password-reset-confirm"),
    re_path(r"^mfa/challenge/?$", MFAChallengeView.as_view(), name="auth-mfa-challenge"),
    re_path(r"^mfa/verify/?$", MFAVerifyView.as_view(), name="auth-mfa-verify"),
    re_path(r"^mfa/recovery/?$", MFARecoveryLoginView.as_view(), name="auth-mfa-recovery"),
    re_path(r"^mfa/setup/?$", MFASetupView.as_view(), name="auth-mfa-setup"),
    re_path(r"^mfa/confirm/?$", MFAConfirmView.as_view(), name="auth-mfa-confirm"),
    re_path(r"^mfa/disable/?$", MFADisableView.as_view(), name="auth-mfa-disable"),
    re_path(r"^mfa/status/?$", MFAStatusView.as_view(), name="auth-mfa-status"),
    re_path(r"^mfa/recovery-codes/regenerate/?$", MFARecoveryRegenerateView.as_view(), name="auth-mfa-recovery-regenerate"),
    re_path(r"^logout/?$", LogoutView.as_view(), name="auth-logout"),
    re_path(r"^me/?$", MeView.as_view(), name="auth-me"),
]

# Security endpoints mounted at /api/v1/security/ or /api/security/
security_urlpatterns = [
    re_path(r"^mfa/setup/?$", MFASetupView.as_view(), name="security-mfa-setup"),
    re_path(r"^mfa/confirm/?$", MFAConfirmView.as_view(), name="security-mfa-confirm"),
    re_path(r"^mfa/disable/?$", MFADisableView.as_view(), name="security-mfa-disable"),
    re_path(r"^mfa/status/?$", MFAStatusView.as_view(), name="security-mfa-status"),
    re_path(r"^mfa/recovery-codes/regenerate/?$", MFARecoveryRegenerateView.as_view(), name="security-mfa-recovery-regenerate"),
]
