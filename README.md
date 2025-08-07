
# gitlab-pipeline-visualizer

Visualizes Gitlab pipelines using OpenTelemetry or Gantt charts.

## Usage

> [!IMPORTANT]
> Make sure you have `FF_TIMESTAMPS: true` in your pipeline variables

Enter into the dev shell

```sh
nix develop
```

Start a trace collector

```
podman run --name jaeger --rm \
    -e COLLECTOR_OTLP_ENABLED=true \
    -p 16686:16686 \
    -p 4317:4317 \
    -p 4318:4318 \
    docker.io/jaegertracing/all-in-one:1.71.0
```

Run the CLI

```sh
pnpm tsx src/bin/ts --help
pnpm tsx src/bin.ts --output=otel 2772 844427
```

## Operations

**Building**

To build the package:

```sh
pnpm build
```

**Testing**

To test the package:

```sh
pnpm test
```

