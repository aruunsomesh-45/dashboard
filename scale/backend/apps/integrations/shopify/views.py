import hashlib
import logging

from django.utils.decorators import method_decorator
from django.views.decorators.csrf import csrf_exempt
from rest_framework import status
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.integrations.models import Integration, WebhookEvent
from apps.integrations.shopify.adapter import ShopifyAdapter
from apps.integrations.tasks import process_webhook_event
from apps.tenancy.models import Brand

logger = logging.getLogger(__name__)


from apps.integrations.webhook_views import ShopifyWebhookView
