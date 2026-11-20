mock_provider "hcloud" {}
variables {
  host_id = "11111111-1111-4111-8111-111111111111"
  cloud_init = "#cloud-config\n{}"
  profile = { serverType="cx43", image=123, location="fsn1", firewalls=[456] }
}
run "merchant_server_plan" {
  command = plan
  assert {
    condition = hcloud_server.merchant.labels["rocento-host"] == var.host_id
    error_message = "The Terraform server must retain its durable fleet identity."
  }
  assert {
    condition = hcloud_server.merchant.delete_protection && hcloud_server.merchant.rebuild_protection && one(hcloud_server.merchant.public_net).ipv4_enabled && !one(hcloud_server.merchant.public_net).ipv6_enabled && hcloud_server.merchant.firewall_ids == toset(var.profile.firewalls)
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
  variables { profile = {serverType="cx43", image=0, location="fsn1", firewalls=[]} }
  expect_failures = [var.profile]
}
