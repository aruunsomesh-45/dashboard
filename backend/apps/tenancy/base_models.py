import uuid

from django.db import models

from .managers import TenantManager


class TenantAwareModel(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workspace = models.ForeignKey(
        "tenancy.Workspace", on_delete=models.CASCADE, related_name="%(app_label)s_%(class)s_set"
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    objects = TenantManager()

    class Meta:
        abstract = True
