import uuid

from django.contrib.auth.models import (
    AbstractBaseUser,
    BaseUserManager,
    PermissionsMixin,
)
from django.db import models


class UserManager(BaseUserManager):
    def get_by_natural_key(self, username):
        """
        Case-insensitive email lookup used by ModelBackend.authenticate().
        Exact match first (uses the unique index), then case-insensitive for legacy mixed-case rows.
        Raises DoesNotExist like the default, so ModelBackend still runs the hasher for unknown emails
        (keeps response time from revealing which emails have accounts).
        """
        email = (username or "").strip()
        user = self.filter(email=email).first() or self.filter(email__iexact=email).order_by("created_at").first()
        if user is None:
            raise self.model.DoesNotExist
        return user

    def create_user(self, email, password=None, **extra_fields):
        if not email:
            raise ValueError("Email is required")
        email = self.normalize_email(email).strip().lower()
        user = self.model(email=email, **extra_fields)
        if password:
            user.set_password(password)
        else:
            user.set_unusable_password()
        user.save(using=self._db)
        return user

    def create_superuser(self, email, password=None, **extra_fields):
        extra_fields.setdefault("is_staff", True)
        extra_fields.setdefault("is_superuser", True)
        extra_fields.setdefault("is_active", True)
        return self.create_user(email, password, **extra_fields)


class User(AbstractBaseUser, PermissionsMixin):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    email = models.EmailField(unique=True, db_index=True)
    first_name = models.CharField(max_length=150, blank=True)
    last_name = models.CharField(max_length=150, blank=True)
    is_active = models.BooleanField(default=True)
    is_staff = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    # Multi-Factor Authentication (TOTP)
    mfa_enabled = models.BooleanField(default=False)
    mfa_secret = models.CharField(max_length=64, blank=True)

    objects = UserManager()

    USERNAME_FIELD = "email"
    REQUIRED_FIELDS = []

    class Meta:
        verbose_name = "User"
        verbose_name_plural = "Users"
        ordering = ["-created_at"]

    def __str__(self):
        return self.email


class MFARecoveryCode(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="recovery_codes")
    code_hash = models.CharField(max_length=128, db_index=True)
    used_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        verbose_name = "MFA Recovery Code"
        verbose_name_plural = "MFA Recovery Codes"

    def is_used(self) -> bool:
        return self.used_at is not None


class UserMFA(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.OneToOneField(User, on_delete=models.CASCADE, related_name="mfa")
    encrypted_totp_secret = models.TextField(blank=True)
    is_enabled = models.BooleanField(default=False)
    confirmed_at = models.DateTimeField(null=True, blank=True)
    last_used_step = models.BigIntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "User MFA"
        verbose_name_plural = "User MFA Configurations"

    def __str__(self):
        return f"MFA for {self.user.email} (enabled={self.is_enabled})"


class MFAChallenge(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="mfa_challenges")
    challenge_token_hash = models.CharField(max_length=64, db_index=True)
    expires_at = models.DateTimeField()
    attempts = models.PositiveSmallIntegerField(default=0)
    consumed_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        verbose_name = "MFA Challenge"
        verbose_name_plural = "MFA Challenges"
        ordering = ["-created_at"]

    def __str__(self):
        return f"Challenge for {self.user.email} (consumed={self.consumed_at is not None})"

    def is_valid(self) -> bool:
        from django.utils import timezone
        if self.consumed_at is not None:
            return False
        if self.attempts >= 5:
            return False
        return timezone.now() < self.expires_at

    def consume(self):
        from django.utils import timezone
        self.consumed_at = timezone.now()
        self.save(update_fields=["consumed_at"])

