"""Workspace provisioning shared by registration and the "create workspace" endpoint."""
from django.db import IntegrityError, transaction
from django.utils.text import slugify

from .models import AuditLog, Brand, Workspace, WorkspaceMember

_MAX_SLUG_ATTEMPTS = 50


def _candidate_slugs(name: str):
    base = (slugify(name) or "workspace")[:40]
    yield base
    for n in range(1, _MAX_SLUG_ATTEMPTS):
        yield f"{base}-{n}"


def create_workspace_for_owner(user, name: str) -> tuple[Workspace, Brand]:
    """
    Create a workspace, make `user` its owner and give it a default brand.

    Runs in a transaction: either all rows exist afterwards or none do. Callers that need a wider
    transaction (registration also creates the user) simply wrap this call in their own atomic block.
    """
    name = name.strip()
    with transaction.atomic():
        workspace = None
        for slug in _candidate_slugs(name):
            if Workspace.objects.filter(slug=slug).exists():
                continue
            try:
                # Savepoint so a concurrent insert of the same slug doesn't poison the outer transaction.
                with transaction.atomic():
                    workspace = Workspace.objects.create(name=name, slug=slug, plan=Workspace.Plan.STARTER)
                break
            except IntegrityError:
                continue
        if workspace is None:
            raise IntegrityError("Could not allocate a unique workspace slug.")

        WorkspaceMember.objects.create(workspace=workspace, user=user, role=WorkspaceMember.Role.OWNER)
        brand = Brand.objects.create(workspace=workspace, name=f"{name} Brand", currency="INR", timezone="Asia/Kolkata")
        AuditLog.objects.create(workspace=workspace, actor=user, action="workspace_created", target=workspace.name)
    return workspace, brand
