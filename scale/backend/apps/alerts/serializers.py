from rest_framework import serializers

from apps.alerts.models import Alert


class AlertSerializer(serializers.ModelSerializer):
    brand_name = serializers.CharField(source="brand.name", read_only=True)
    acknowledged_by_email = serializers.EmailField(source="acknowledged_by.email", read_only=True, default="")

    class Meta:
        model = Alert
        fields = [
            "id",
            "brand",
            "brand_name",
            "title",
            "description",
            "severity",
            "status",
            "dedupe_key",
            "acknowledged_by_email",
            "acknowledged_at",
            "resolved_at",
            "created_at",
            "updated_at",
        ]
        read_only_fields = ["id", "dedupe_key", "created_at", "updated_at"]
