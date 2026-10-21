FROM python:3.12-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
COPY requirements.lock .
RUN pip install --no-cache-dir --require-hashes -r requirements.lock
COPY app ./app
COPY knowledge ./knowledge
# COPY retains host directory modes; the service user must read the language release.
RUN chmod 755 app/commerce_language_engine app/commerce_language_engine/data && \
    chmod 644 app/commerce_language_engine/data/compiled.json
RUN mkdir /models /var/lib/assistant-config && chown 10001:10001 /models /var/lib/assistant-config && chmod 700 /var/lib/assistant-config
USER 10001:10001
RUN python -c "from app.main import app; from app.commerce_action_engine.actions.shopping.context import _published_sentence_rules; assert _published_sentence_rules(), 'Published language rules must be readable and nonempty for the service user'"
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log", "--limit-concurrency", "16", "--timeout-keep-alive", "5"]
