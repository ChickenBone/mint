FROM python:3.12-slim
RUN apt-get update -qq && apt-get install -y --no-install-recommends postgresql-client \
    && apt-get clean
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
ENV HF_HUB_DISABLE_TELEMETRY=1 DO_NOT_TRACK=1
WORKDIR /service
COPY pyproject.toml ./
COPY catalog ./catalog
RUN pip install . && useradd --uid 10001 --create-home catalog \
    && mkdir /models && chown catalog:catalog /models
USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["mint-catalog"]
CMD ["serve"]
