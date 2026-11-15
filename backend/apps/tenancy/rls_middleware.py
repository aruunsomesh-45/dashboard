from django.db import connection


class RLSMiddleware:
    """
    Sets the active PostgreSQL tenant context in the current transaction.
    Uses 'SET LOCAL app.workspace_id' which dies automatically with the transaction,
    making it completely safe for PgBouncer transaction pooling.
    """

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        if hasattr(request, "tenant") and request.tenant and request.tenant.workspace:
            # Check if Postgres engine
            if connection.vendor == "postgresql":
                with connection.cursor() as cursor:
                    cursor.execute("SET LOCAL app.workspace_id = %s;", [str(request.tenant.workspace.id)])
        return self.get_response(request)
