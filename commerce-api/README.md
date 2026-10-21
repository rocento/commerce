# Commerce API services

`commerce-api/` groups independent backend services. The main commerce backend
and customer onboarding API are separate Rust packages with their own Cargo
manifests and dependency locks. A small Python health dashboard API and sampler
live in `health-api/`.

- [Rocento commerce API](rocento-api/README.md) owns the production gateway,
  domain crates, commerce migrations, and API contracts.
- [Onboarding API](onboard-api/README.md) owns the standalone customer
  onboarding service and its migrations.
- `health-api/` serves the authenticated health dashboard and runs its
  read-only health sampler; deployment instructions are in the [EC2 guide](../commerce-ops/deploy/ec2/README.md#private-production-health-dashboard).

Run each service from its own directory, or pass the corresponding manifest:

```sh
cargo check --locked --manifest-path commerce-api/rocento-api/Cargo.toml
cargo check --locked --manifest-path commerce-api/onboard-api/Cargo.toml
```
