# Load the project's Celery app when Django starts so @shared_task binds to it (and to the CELERY_* settings,
# e.g. CELERY_TASK_ALWAYS_EAGER). Without this, tasks bound to Celery's unconfigured default app, which tried to
# reach an AMQP broker on localhost: every webhook was stored but its processing failed. (QA 2026-11-21)
from .celery import app as celery_app

__all__ = ("celery_app",)
