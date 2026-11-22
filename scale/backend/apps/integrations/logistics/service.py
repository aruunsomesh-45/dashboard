import logging
from django.db import transaction

from apps.commerce.models import Shipment
from apps.integrations.logistics.adapter import ShiprocketAdapter
from apps.integrations.models import Integration

logger = logging.getLogger(__name__)


def ingest_shiprocket_tracking(brand, raw_payload: dict) -> Shipment:
    """
    Ingests a Shiprocket tracking webhook payload.
    - Normalizes status via map_logistics_status (unknown status safely falls back to IN_TRANSIT and logs warning).
    - Upserts canonical Shipment record.
    - Never crashes sync on unknown codes.
    """
    integration = Integration.objects.filter(brand=brand, provider=Integration.Provider.SHIPROCKET).first()
    adapter = ShiprocketAdapter(integration)
    norm = adapter.normalize_shipment(raw_payload)

    with transaction.atomic():
        shipment, _ = Shipment.objects.update_or_create(
            workspace=brand.workspace,
            brand=brand,
            provider="shiprocket",
            provider_id=norm["provider_id"],
            defaults={
                "awb": norm["awb"],
                "courier_name": norm["courier_name"],
                "canonical_status": norm["canonical_status"],
                "raw_status": norm["raw_status"],
                "ndr_count": norm["ndr_count"],
            },
        )
    return shipment
