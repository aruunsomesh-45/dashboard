from django.db import models


class TenantQuerySet(models.QuerySet):
    def for_tenant(self, workspace):
        if not workspace:
            return self.none()
        return self.filter(workspace=workspace)

    def for_brand(self, brand):
        if not brand:
            return self.none()
        return self.filter(brand=brand)


class TenantManager(models.Manager):
    def get_queryset(self):
        return TenantQuerySet(self.model, using=self._db)

    def for_tenant(self, workspace):
        return self.get_queryset().for_tenant(workspace)

    def for_brand(self, brand):
        return self.get_queryset().for_brand(brand)
