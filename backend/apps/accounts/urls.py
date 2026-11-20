from django.urls import re_path

from .views import (
    CsrfView,
    LoginView,
    LogoutView,
    MeView,
    MFAChallengeView,
    MFAConfirmView,
    MFASetupView,
    PasswordResetConfirmView,
    PasswordResetRequestView,
    RegisterView,
)

urlpatterns = [
    re_path(r"^csrf/?$", CsrfView.as_view(), name="auth-csrf"),
    re_path(r"^register/?$", RegisterView.as_view(), name="auth-register"),
    re_path(r"^login/?$", LoginView.as_view(), name="auth-login"),
    re_path(r"^password-reset/?$", PasswordResetRequestView.as_view(), name="auth-password-reset"),
    re_path(r"^password-reset/confirm/?$", PasswordResetConfirmView.as_view(), name="auth-password-reset-confirm"),
    re_path(r"^mfa/challenge/?$", MFAChallengeView.as_view(), name="auth-mfa-challenge"),
    re_path(r"^mfa/setup/?$", MFASetupView.as_view(), name="auth-mfa-setup"),
    re_path(r"^mfa/confirm/?$", MFAConfirmView.as_view(), name="auth-mfa-confirm"),
    re_path(r"^logout/?$", LogoutView.as_view(), name="auth-logout"),
    re_path(r"^me/?$", MeView.as_view(), name="auth-me"),
]
