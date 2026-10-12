# CI validates digest references and stages an explicit tools allowlist. The
# baseline lock and tool-lock.json must be generated and reviewed before build.
ARG PYTHON_IMAGE
ARG UV_IMAGE
FROM ${UV_IMAGE} AS uv
FROM ${PYTHON_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends git ripgrep libssl3 libstdc++6 ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=uv /uv /usr/local/bin/uv
COPY pyproject.toml uv.lock tool-lock.json /opt/scikeel/baseline/
ENV UV_PYTHON_DOWNLOADS=never UV_LINK_MODE=copy
ENV UV_PROJECT_ENVIRONMENT=/opt/scikeel/science
WORKDIR /opt/scikeel/baseline
RUN uv sync --locked --no-dev --no-install-project --no-cache
COPY tools/ /opt/scikeel/tools/
ENV PATH=/opt/scikeel/science/bin:/opt/scikeel/tools/bin:/usr/local/bin:/usr/bin:/bin
ENV OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 MKL_NUM_THREADS=1 NUMEXPR_NUM_THREADS=1
ENV PYTHONDONTWRITEBYTECODE=1
RUN dpkg-query -W > /opt/scikeel/baseline/system-packages.txt
USER 1000:1000
ENTRYPOINT ["/opt/scikeel/tools/bin/osd", "version"]
