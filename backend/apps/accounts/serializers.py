from django.contrib.auth import authenticate
from django.contrib.auth.password_validation import validate_password as django_validate_password
from django.core.exceptions import ValidationError as DjangoValidationError
from rest_framework import serializers

from .models import User
from .services import check_have_i_been_pwned

INVALID_CREDENTIALS = "Invalid email or password."
DUPLICATE_EMAIL = "An account with this email already exists."


def _check_password_strength(password: str, email: str = "") -> None:
    """Django validators (length >= 10, common, numeric, similar-to-email), then HaveIBeenPwned."""
    try:
        django_validate_password(password, user=User(email=email))
    except DjangoValidationError as exc:
        raise serializers.ValidationError({"password": list(exc.messages)}) from None
    if check_have_i_been_pwned(password):
        raise serializers.ValidationError(
            {"password": ["This password has appeared in a data breach. Please choose a different password."]}
        )


class RegisterSerializer(serializers.Serializer):
    workspace_name = serializers.CharField(max_length=255, trim_whitespace=True)
    email = serializers.EmailField(max_length=254)
    password = serializers.CharField(write_only=True, trim_whitespace=False, max_length=128)
    confirm_password = serializers.CharField(write_only=True, trim_whitespace=False, max_length=128)

    def validate_email(self, value):
        email = value.strip().lower()
        if User.objects.filter(email__iexact=email).exists():
            raise serializers.ValidationError(DUPLICATE_EMAIL)
        return email

    def validate_workspace_name(self, value):
        if not value.strip():
            raise serializers.ValidationError("Workspace name is required.")
        return value.strip()

    def validate(self, attrs):
        if attrs["password"] != attrs["confirm_password"]:
            raise serializers.ValidationError({"confirm_password": ["Passwords do not match."]})
        _check_password_strength(attrs["password"], attrs["email"])
        return attrs


class LoginSerializer(serializers.Serializer):
    email = serializers.EmailField()
    password = serializers.CharField(write_only=True, trim_whitespace=False)

    def validate(self, attrs):
        # authenticate() rejects inactive users and unknown emails with the same None result,
        # and hashes the password either way, so neither the message nor the timing leaks account existence.
        user = authenticate(email=attrs["email"].strip().lower(), password=attrs["password"])
        if not user:
            raise serializers.ValidationError(INVALID_CREDENTIALS)
        attrs["user"] = user
        return attrs


class PasswordResetRequestSerializer(serializers.Serializer):
    email = serializers.EmailField()


class PasswordResetConfirmSerializer(serializers.Serializer):
    uid = serializers.CharField()
    token = serializers.CharField()
    password = serializers.CharField(write_only=True, trim_whitespace=False, max_length=128)
    confirm_password = serializers.CharField(write_only=True, trim_whitespace=False, max_length=128)

    def validate(self, attrs):
        if attrs["password"] != attrs["confirm_password"]:
            raise serializers.ValidationError({"confirm_password": ["Passwords do not match."]})
        return attrs


class MFAChallengeSerializer(serializers.Serializer):
    code = serializers.CharField(max_length=32)


class MFASetupConfirmSerializer(serializers.Serializer):
    code = serializers.CharField(max_length=6, min_length=6)


class UserSerializer(serializers.ModelSerializer):
    class Meta:
        model = User
        fields = ["id", "email", "first_name", "last_name", "mfa_enabled", "created_at"]
