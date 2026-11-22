"""
Tenant-Isolated Caching Engine for 125 EAST SaaS Cockpit
Ensures zero cross-tenant cache contamination and enforces strict invalidation rules.
"""

import logging
from typing import Any, Callable, Optional
from django.core.cache import cache

logger = logging.getLogger(__name__)

DEFAULT_DASHBOARD_TTL = 300  # 5 minutes


def make_tenant_cache_key(
    workspace_slug: str,
    brand_id: str,
    metric_namespace: str,
    **kwargs: Any
) -> str:
    """
    Constructs an isolated, deterministic cache key scoped strictly to a tenant and brand.
    Example: tenant:alpha-corp:brand:3a1b...:shopify_stats:days=30
    """
    kwarg_str = ":".join(f"{k}={v}" for k, v in sorted(kwargs.items()))
    suffix = f":{kwarg_str}" if kwarg_str else ""
    return f"tenant:{workspace_slug}:brand:{brand_id}:{metric_namespace}{suffix}"


def get_cached_tenant_data(
    workspace_slug: str,
    brand_id: str,
    metric_namespace: str,
    compute_fn: Callable[[], Any],
    ttl: int = DEFAULT_DASHBOARD_TTL,
    **kwargs: Any
) -> tuple[Any, bool]:
    """
    Retrieves data from cache or computes and caches it.
    Returns: (data, is_cache_hit: bool)
    """
    key = make_tenant_cache_key(workspace_slug, brand_id, metric_namespace, **kwargs)
    cached_val = cache.get(key)
    if cached_val is not None:
        logger.debug(f"[CACHE HIT] {key}")
        return cached_val, True

    logger.debug(f"[CACHE MISS] Computing {key}")
    fresh_val = compute_fn()
    cache.set(key, fresh_val, timeout=ttl)
    return fresh_val, False


def invalidate_brand_cache(workspace_slug: str, brand_id: str) -> None:
    """
    Invalidates cached summaries for a specific brand upon webhook ingestion
    or sync trigger. Clears common window keys (7D, 30D, 90D, 180D).
    """
    windows = [7, 30, 90, 180]
    namespaces = ["shopify_stats", "metrics_summary"]
    keys_to_delete = []

    for ns in namespaces:
        for w in windows:
            keys_to_delete.append(make_tenant_cache_key(workspace_slug, brand_id, ns, days=w))
            keys_to_delete.append(make_tenant_cache_key(workspace_slug, brand_id, ns))

    cache.delete_many(keys_to_delete)
    logger.info(f"[CACHE INVALIDATED] Cleared {len(keys_to_delete)} keys for tenant={workspace_slug} brand={brand_id}")
