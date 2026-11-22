from django.contrib import admin

from .models import Brand, BrandMember, Workspace, WorkspaceMember


@admin.register(Workspace)
class WorkspaceAdmin(admin.ModelAdmin):
    list_display = ("name", "slug", "plan", "is_active", "created_at")
    search_fields = ("name", "slug")
    prepopulated_fields = {"slug": ("name",)}


@admin.register(WorkspaceMember)
class WorkspaceMemberAdmin(admin.ModelAdmin):
    list_display = ("workspace", "user", "role", "created_at")
    list_filter = ("role", "workspace")
    search_fields = ("user__email", "workspace__name")


@admin.register(Brand)
class BrandAdmin(admin.ModelAdmin):
    list_display = ("name", "workspace", "currency", "timezone", "created_at")
    list_filter = ("workspace", "currency")
    search_fields = ("name", "workspace__name")


@admin.register(BrandMember)
class BrandMemberAdmin(admin.ModelAdmin):
    list_display = ("brand", "user", "created_at")
    search_fields = ("user__email", "brand__name")
