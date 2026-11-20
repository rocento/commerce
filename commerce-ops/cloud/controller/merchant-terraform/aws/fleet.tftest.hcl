mock_provider "aws" {}
variables {
  host_id = "11111111-1111-4111-8111-111111111111"
  cloud_init = "#cloud-config\n{}"
  profile = { region="eu-west-1", launchTemplateId="lt-0123456789abcdef0", launchTemplateVersion="1" }
}
run "merchant_server_plan" {
  command = plan
  assert {
    condition = aws_instance.merchant.tags["rocento-host"] == var.host_id
    error_message = "The Terraform server must retain its durable fleet identity."
  }
  assert {
    condition = aws_instance.merchant.disable_api_termination && aws_instance.merchant.metadata_options[0].http_tokens == "required" && aws_instance.merchant.metadata_options[0].http_put_response_hop_limit == 1
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
  variables { profile = {region="eu-west-1", launchTemplateId="lt-0123456789abcdef0", launchTemplateVersion="$Latest"} }
  expect_failures = [var.profile]
}
