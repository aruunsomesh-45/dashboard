from django.contrib.auth import authenticate
from rest_framework import serializers

from .models import User
from .services import check_have_i_been_pwned


class RegisterSerializer(serializers.ModelSerializer):
    password = serializers.CharField(write_only=True, min_length=10)

    class Meta:
        model = User
        fields = ["id", "email", "password", "first_name", "last_name"]

    def validate_password(self, value):
        if len(value) < 10:
            raise serializers.ValidationError("Password must be at least 10 characters long.")
        if check_have_i_been_pwned(value):
            raise serializers.ValidationError(
                "This password has been exposed in a data breach. Please choose a different password."
            )
        return value

    def create(self, validated_data):
        return User.objects.create_user(**validated_data)


class LoginSerializer(serializers.Serializer):
    email = serializers.EmailField()
    password = serializers.CharField(write_only=True)

    def validate(self, attrs):
        email = attrs.get("email", "").strip().lower()
        password = attrs.get("password")

        user = authenticate(email=email, password=password)
        if not user:
            raise serializers.ValidationError("Invalid email or password.")
        if not user.is_active:
            raise serializers.ValidationError("Account is inactive.")

        attrs["user"] = user
        return attrs


class MFAChallengeSerializer(serializers.Serializer):
    code = serializers.CharField(max_length=32)


class MFASetupConfirmSerializer(serializers.Serializer):
    code = serializers.CharField(max_length=6, min_length=6)


class UserSerializer(serializers.ModelSerializer):
    class Meta:
        model = User
        fields = ["id", "email", "first_name", "last_name", "mfa_enabled", "created_at"]
