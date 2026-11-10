FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /service
COPY pyproject.toml ./
COPY auditor ./auditor
RUN pip install . && useradd --uid 10001 --create-home auditor
USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["mint-library-auditor"]
CMD ["serve"]
