from django.contrib import admin
from django.http import JsonResponse
from django.shortcuts import redirect
from django.urls import include, path, re_path
from drf_spectacular.views import SpectacularAPIView, SpectacularSwaggerView
from apps.tenancy.views import WorkspaceListCreateView


def root_view(request):
    # If opened in a web browser, redirect to interactive Swagger API docs
    accept = request.headers.get("Accept", "")
    if "text/html" in accept:
        return redirect("/api/docs/")
    return JsonResponse(
        {
            "service": "125 EAST Commerce Intelligence API",
            "status": "healthy",
            "version": "1.0.0",
            "documentation": "/api/docs/",
            "admin": "/admin/",
            "frontend": "http://localhost:3000",
        }
    )


urlpatterns = [
    path("", root_view, name="api-root"),
    re_path(r"^api/health/?$", root_view, name="api-health"),
    path("admin/", admin.site.urls),
    # OpenAPI 3 Schema & Swagger UI for AI Frontend integration
    re_path(r"^api/schema/?$", SpectacularAPIView.as_view(), name="schema"),
    re_path(
        r"^api/docs/?$",
        SpectacularSwaggerView.as_view(url_name="schema"),
        name="swagger-ui",
    ),
    # Modular Monolith API Routes
    re_path(r"^api/auth/?", include("apps.accounts.urls")),
    path("api/w", WorkspaceListCreateView.as_view(), name="workspace-list-create-noslash"),
    path("api/w/", include("apps.tenancy.urls")),
    path("api/", include("apps.integrations.urls")),
]
