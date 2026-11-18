mock_provider "google" {}
variables {
  host_id = "11111111-1111-4111-8111-111111111111"
  cloud_init = "#cloud-config\n{}"
  profile = { project="fixture-project", zone="europe-west1-b", instanceTemplate="https://www.googleapis.com/compute/v1/projects/fixture-project/global/instanceTemplates/fixture" }
}
run "merchant_server_plan" {
  command = plan
  assert {
    condition = google_compute_instance_from_template.merchant.labels["rocento-host"] == var.host_id
    error_message = "The Terraform server must retain its durable fleet identity."
  }
  assert {
    condition = google_compute_instance_from_template.merchant.deletion_protection && google_compute_instance_from_template.merchant.metadata["enable-oslogin"] == "FALSE" && google_compute_instance_from_template.merchant.metadata["block-project-ssh-keys"] == "true"
    error_message = "The VM must retain protection and provider-specific access settings."
  }
}
run "reject_invalid_host_identity" {
  command = plan
  variables { host_id = "invalid-host" }
  expect_failures = [var.host_id]
}
run "reject_invalid_cloud_init" {
  command = plan
  variables { cloud_init = "invalid-config" }
  expect_failures = [var.cloud_init]
}
run "reject_unpinned_profile" {
  command = plan
  variables { profile = {project="fixture-project", zone="europe-west1-b", instanceTemplate="unbound-template"} }
  expect_failures = [var.profile]
}
