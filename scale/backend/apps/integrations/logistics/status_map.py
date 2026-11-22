import logging

from apps.commerce.models import CanonicalShipmentStatus

logger = logging.getLogger(__name__)

# Dictionary map: courier/raw status code -> CanonicalShipmentStatus
# Fallback is always CanonicalShipmentStatus.IN_TRANSIT
SHIPROCKET_STATUS_MAP = {
    # Shiprocket Status IDs and Codes
    "1": CanonicalShipmentStatus.CREATED,
    "2": CanonicalShipmentStatus.PICKUP_PENDING,
    "3": CanonicalShipmentStatus.PICKUP_PENDING,
    "6": CanonicalShipmentStatus.IN_TRANSIT,
    "7": CanonicalShipmentStatus.OUT_FOR_DELIVERY,
    "8": CanonicalShipmentStatus.DELIVERED,
    "9": CanonicalShipmentStatus.CANCELLED,
    "17": CanonicalShipmentStatus.OUT_FOR_DELIVERY,
    "18": CanonicalShipmentStatus.IN_TRANSIT,
    "19": CanonicalShipmentStatus.NDR,
    "20": CanonicalShipmentStatus.NDR,
    "21": CanonicalShipmentStatus.NDR,
    "13": CanonicalShipmentStatus.RTO_INITIATED,
    "14": CanonicalShipmentStatus.RTO_DELIVERED,
    "RAD": CanonicalShipmentStatus.OUT_FOR_DELIVERY,
    "DEL": CanonicalShipmentStatus.DELIVERED,
    "CAN": CanonicalShipmentStatus.CANCELLED,
    "RTO": CanonicalShipmentStatus.RTO_INITIATED,
    "NDR": CanonicalShipmentStatus.NDR,
}


def map_logistics_status(raw_status: str | int) -> str:
    """
    Safely normalizes carrier status codes to CanonicalShipmentStatus.
    If code is unknown, logs a warning and safely defaults to IN_TRANSIT without crashing.
    """
    code_str = str(raw_status).strip().upper()
    if code_str not in SHIPROCKET_STATUS_MAP:
        logger.warning("Unknown Shiprocket status '%s', falling back to IN_TRANSIT", raw_status)
        return CanonicalShipmentStatus.IN_TRANSIT
    return SHIPROCKET_STATUS_MAP[code_str]
