mock_provider "aws" {
  mock_data "aws_subnet" { defaults = { vpc_id = "vpc-0123456789abcdef0" } }
  mock_data "aws_ami" {
    defaults = { public = true, name = "ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-arm64-server-20261101", state = "available", block_device_mappings = [{ device_name = "/dev/sda1", ebs = { volume_size = 60 } }], architecture = "arm64", root_device_name = "/dev/sda1", root_device_type = "ebs", virtualization_type = "hvm" }
  }
  mock_data "aws_ec2_instance_type" {
    defaults = { instance_storage_supported = false, memory_size = 16384, default_vcpus = 4, supported_architectures = ["arm64"] }
  }
}
override_resource {
  target          = aws_s3_bucket.state
  override_during = plan
  values          = { id = "fixture-merchant-state", arn = "arn:aws:s3:::fixture-merchant-state" }
}
override_resource {
  target          = aws_security_group.merchant
  override_during = plan
  values          = { id = "sg-0123456789abcdef0" }
}
override_resource {
  target          = aws_launch_template.merchant
  override_during = plan
  values          = { id = "lt-0123456789abcdef0", arn = "arn:aws:ec2:eu-central-1:111122223333:launch-template/lt-0123456789abcdef0", latest_version = 1 }
}
variables {
  account_id             = "111122223333"
  region                 = "eu-central-1"
  environment            = "aws-onboarding-test"
  vpc_id                 = "vpc-0123456789abcdef0"
  subnet_id              = "subnet-0123456789abcdef0"
  merchant_ami_id        = "ami-0123456789abcdef0"
  instance_type          = "t4g.xlarge"
  controller_ssh_cidr    = "192.0.2.1/32"
  https_proxy_ipv4_cidrs = ["192.0.2.0/24"]
  state_bucket_name      = "fixture-merchant-state"
}
run "secure_foundation_and_scoped_policy" {
  command = plan
  assert {
    condition     = aws_s3_bucket_versioning.state.versioning_configuration[0].status == "Enabled" && aws_s3_bucket_public_access_block.state.block_public_acls && aws_s3_bucket_public_access_block.state.block_public_policy && aws_s3_bucket_public_access_block.state.ignore_public_acls && aws_s3_bucket_public_access_block.state.restrict_public_buckets && !aws_s3_bucket.state.force_destroy
    error_message = "State must retain versioning, all public-access protections and deletion safety."
  }
  assert {
    condition     = one(aws_s3_bucket_server_side_encryption_configuration.state.rule).apply_server_side_encryption_by_default[0].sse_algorithm == "AES256" && aws_s3_bucket_ownership_controls.state.rule[0].object_ownership == "BucketOwnerEnforced" && jsondecode(aws_s3_bucket_policy.state.policy).Statement[0].Condition.Bool["aws:SecureTransport"] == "false"
    error_message = "State must use encryption, bucket ownership and mandatory TLS."
  }
  assert {
    condition     = length(aws_security_group.merchant.ingress) == 2 && alltrue([for rule in aws_security_group.merchant.ingress : rule.protocol == "tcp" && rule.from_port == rule.to_port && (rule.from_port == 22 ? rule.cidr_blocks == tolist([var.controller_ssh_cidr]) : rule.from_port == 443 && rule.cidr_blocks == var.https_proxy_ipv4_cidrs)])
    error_message = "Only controller SSH and proxy HTTPS may reach the merchant host."
  }
  assert {
    condition     = aws_launch_template.merchant.disable_api_termination && aws_launch_template.merchant.metadata_options[0].http_tokens == "required" && aws_launch_template.merchant.metadata_options[0].http_put_response_hop_limit == 1 && one(aws_launch_template.merchant.block_device_mappings).ebs[0].encrypted && length(aws_launch_template.merchant.iam_instance_profile) == 0 && aws_launch_template.merchant.user_data == null
    error_message = "Nodes need encrypted storage, IMDSv2, protection and no inherited controller identity or user data."
  }
  assert {
    condition     = alltrue([for statement in local.provisioning_policy.Statement : statement.Resource != "*" || statement.Sid == "ReadEC2ForTerraformAndReconciliation"])
    error_message = "Only necessary read-only EC2 discovery may use wildcard resources."
  }
  assert {
    condition     = alltrue([for statement in local.provisioning_policy.Statement : alltrue([for action in flatten([statement.Action]) : contains(["ec2:RunInstances", "ec2:CreateTags", "s3:GetBucketLocation", "s3:ListBucket", "s3:GetObject", "s3:PutObject", "s3:DeleteObject"], action) || startswith(action, "ec2:Describe")])])
    error_message = "Provisioning must not grant IAM administration, foundation mutations or instance termination."
  }
  assert {
    condition     = alltrue([for statement in local.provisioning_policy.Statement : !contains(flatten([statement.Action]), "s3:DeleteObject") || endswith(statement.Resource, ".tfstate.tflock")])
    error_message = "Deletion must be restricted to lock objects."
  }
  assert {
    condition     = !output.fleet_config_fragment.enabled && output.fleet_config_fragment.providers.aws.launchTemplateVersion == "1" && output.fleet_config_fragment.providers.aws.maxHosts == 2
    error_message = "Outputs must remain disabled, capacity bounded and template version pinned."
  }
  assert {
    condition     = length(output.provisioning_policy_json) <= 6144
    error_message = "The rendered policy must fit the IAM managed-policy character limit."
  }
  assert {
    condition     = alltrue([for statement in local.provisioning_policy.Statement : statement.Action != "ec2:RunInstances" || statement.Sid == "UseApprovedTemplate" || try(statement.Condition.ArnEquals["ec2:LaunchTemplate"] == aws_launch_template.merchant.arn, false)])
    error_message = "Every launch resource permission must bind the approved template."
  }
  assert {
    condition     = alltrue([for statement in local.provisioning_policy.Statement : !contains(flatten([statement.Action]), "s3:PutObject") || startswith(statement.Resource, "arn:aws:s3:::fixture-merchant-state/merchant-fleet/onboarding-test/aws/")])
    error_message = "Writes must not escape the AWS fleet state prefix."
  }
}
run "four_vcpu_arm_test_host" {
  command = plan
  variables { instance_type = "t4g.xlarge" }
  assert {
    condition     = aws_launch_template.merchant.instance_type == "t4g.xlarge" && one([for statement in local.provisioning_policy.Statement : statement if statement.Sid == "CreateMerchantInstance"]).Condition.StringEquals["ec2:InstanceType"] == "t4g.xlarge"
    error_message = "The isolated four-vCPU host and its IAM launch permission must select t4g.xlarge together."
  }
}
run "reject_public_ssh" {
  command = plan
  variables { controller_ssh_cidr = "0.0.0.0/0" }
  expect_failures = [var.controller_ssh_cidr]
}
run "reject_public_https" {
  command = plan
  variables { https_proxy_ipv4_cidrs = ["0.0.0.0/0"] }
  expect_failures = [var.https_proxy_ipv4_cidrs]
}
run "reject_unconfigured_proxy_list" {
  command = plan
  variables { https_proxy_ipv4_cidrs = [] }
  expect_failures = [var.https_proxy_ipv4_cidrs]
}
run "reject_placeholder_ami" {
  command = plan
  variables { merchant_ami_id = "REPLACE_AMI" }
  expect_failures = [var.merchant_ami_id]
}
run "reject_wildcard_state_scope" {
  command = plan
  variables { state_key_prefix = "merchant-fleet/*" }
  expect_failures = [var.state_key_prefix]
}
run "reject_wrong_subnet_vpc" {
  command = plan
  override_data {
    target = data.aws_subnet.merchant
    values = { vpc_id = "vpc-fffffffffffffffff" }
  }
  expect_failures = [aws_security_group.merchant]
}
run "reject_small_instance" {
  command = plan
  override_data {
    target = data.aws_ec2_instance_type.merchant
    values = { memory_size = 8192, supported_architectures = ["arm64"] }
  }
  expect_failures = [aws_launch_template.merchant]
}
run "reject_wrong_architecture" {
  command = plan
  override_data {
    target = data.aws_ami.merchant
    values = { public = true, name = "ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-arm64-server-20261101", state = "available", block_device_mappings = [{ device_name = "/dev/sda1", ebs = { volume_size = 60 } }], architecture = "x86_64", root_device_name = "/dev/sda1", root_device_type = "ebs", virtualization_type = "hvm" }
  }
  expect_failures = [aws_launch_template.merchant]
}

run "reject_invalid_account" {
  command = plan
  variables { account_id = "123" }
  expect_failures = [var.account_id]
}

run "reject_noncommercial_region" {
  command = plan
  variables { region = "cn-north-1" }
  expect_failures = [var.region]
}

run "reject_wildcard_region" {
  command = plan
  variables { region = "*" }
  expect_failures = [var.region]
}

run "reject_wildcard_subnet" {
  command = plan
  variables { subnet_id = "subnet-*" }
  expect_failures = [var.subnet_id]
}

run "reject_wildcard_type" {
  command = plan
  variables { instance_type = "t4g.*" }
  expect_failures = [var.instance_type]
}

run "reject_wildcard_vpc" {
  command = plan
  variables { vpc_id = "vpc-*" }
  expect_failures = [var.vpc_id]
}

run "reject_long_state_prefix" {
  command = plan
  variables { state_key_prefix = "merchant-fleet/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }
  expect_failures = [var.state_key_prefix]
}

run "reject_traversal_prefix" {
  command = plan
  variables { state_key_prefix = "merchant-fleet/../other" }
  expect_failures = [var.state_key_prefix]
}

run "reject_duplicate_proxies" {
  command = plan
  variables { https_proxy_ipv4_cidrs = ["192.0.2.0/24", "192.0.2.0/24"] }
  expect_failures = [var.https_proxy_ipv4_cidrs]
}

run "reject_ipv6_proxies" {
  command = plan
  variables { https_proxy_ipv4_cidrs = ["::/0"] }
  expect_failures = [var.https_proxy_ipv4_cidrs]
}

run "reject_malformed_proxy" {
  command = plan
  variables { https_proxy_ipv4_cidrs = ["not-a-cidr"] }
  expect_failures = [var.https_proxy_ipv4_cidrs]
}

run "reject_too_many_proxies" {
  command = plan
  variables { https_proxy_ipv4_cidrs = [for i in range(60) : "192.0.${i}.0/24"] }
  expect_failures = [var.https_proxy_ipv4_cidrs]
}

run "reject_small_disk" {
  command = plan
  variables { root_volume_gib = 99 }
  expect_failures = [var.root_volume_gib]
}

run "reject_fractional_disk" {
  command = plan
  variables { root_volume_gib = 100.5 }
  expect_failures = [var.root_volume_gib]
}

run "reject_oversized_disk" {
  command = plan
  variables { root_volume_gib = 1001 }
  expect_failures = [var.root_volume_gib]
}

run "reject_private_ami" {
  command = plan
  override_data {
    target = data.aws_ami.merchant
    values = { public = false, state = "available", architecture = "arm64", root_device_name = "/dev/sda1", root_device_type = "ebs", virtualization_type = "hvm", block_device_mappings = [{ device_name = "/dev/sda1", ebs = { volume_size = 60 } }] }
  }
  expect_failures = [aws_launch_template.merchant]
}

run "reject_pending_ami" {
  command = plan
  override_data {
    target = data.aws_ami.merchant
    values = { public = true, name = "ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-arm64-server-20261101", state = "pending", architecture = "arm64", root_device_name = "/dev/sda1", root_device_type = "ebs", virtualization_type = "hvm", block_device_mappings = [{ device_name = "/dev/sda1", ebs = { volume_size = 60 } }] }
  }
  expect_failures = [aws_launch_template.merchant]
}

run "reject_instance_store_ami" {
  command = plan
  override_data {
    target = data.aws_ami.merchant
    values = { public = true, name = "ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-arm64-server-20261101", state = "available", architecture = "arm64", root_device_name = "/dev/sda1", root_device_type = "instance-store", virtualization_type = "hvm", block_device_mappings = [{ device_name = "/dev/sda1", ebs = { volume_size = 60 } }] }
  }
  expect_failures = [aws_launch_template.merchant]
}

run "reject_paravirtual_ami" {
  command = plan
  override_data {
    target = data.aws_ami.merchant
    values = { public = true, name = "ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-arm64-server-20261101", state = "available", architecture = "arm64", root_device_name = "/dev/sda1", root_device_type = "ebs", virtualization_type = "paravirtual", block_device_mappings = [{ device_name = "/dev/sda1", ebs = { volume_size = 60 } }] }
  }
  expect_failures = [aws_launch_template.merchant]
}

run "reject_snapshot_too_large" {
  command = plan
  override_data {
    target = data.aws_ami.merchant
    values = { public = true, name = "ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-arm64-server-20261101", state = "available", architecture = "arm64", root_device_name = "/dev/sda1", root_device_type = "ebs", virtualization_type = "hvm", block_device_mappings = [{ device_name = "/dev/sda1", ebs = { volume_size = 150 } }] }
  }
  expect_failures = [aws_launch_template.merchant]
}

run "reject_extra_disk" {
  command = plan
  override_data {
    target = data.aws_ami.merchant
    values = { public = true, name = "ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-arm64-server-20261101", state = "available", architecture = "arm64", root_device_name = "/dev/sda1", root_device_type = "ebs", virtualization_type = "hvm", block_device_mappings = [{ device_name = "/dev/sda1", ebs = { volume_size = 60 } }, { device_name = "/dev/sdb", ebs = { volume_size = 20 } }] }
  }
  expect_failures = [aws_launch_template.merchant]
}

run "accept_x86_and_minimum_memory" {
  command = plan
  variables { instance_type = "m6i.2xlarge" }
  override_data {
    target = data.aws_ec2_instance_type.merchant
    values = { memory_size = 16384, default_vcpus = 4, supported_architectures = ["x86_64"] }
  }
  override_data {
    target = data.aws_ami.merchant
    values = { public = true, name = "ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-arm64-server-20261101", state = "available", architecture = "x86_64", root_device_name = "/dev/sda1", root_device_type = "ebs", virtualization_type = "hvm", block_device_mappings = [{ device_name = "/dev/sda1", ebs = { volume_size = 100 } }] }
  }
}

run "reject_non_ubuntu_2404_image" {
  command = plan
  override_data {
    target = data.aws_ami.merchant
    values = { public = true, name = "unapproved-image", state = "available", architecture = "arm64", root_device_name = "/dev/sda1", root_device_type = "ebs", virtualization_type = "hvm", block_device_mappings = [{ device_name = "/dev/sda1", ebs = { volume_size = 60 } }] }
  }
  expect_failures = [aws_launch_template.merchant]
}

run "canonical_ephemeral_mappings_do_not_emit_bare_devices" {
  command = plan
  override_data {
    target = data.aws_ami.merchant
    values = { public = true, name = "ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-arm64-server-20261108", state = "available", architecture = "arm64", root_device_name = "/dev/sda1", root_device_type = "ebs", virtualization_type = "hvm", block_device_mappings = [{ device_name = "/dev/sda1", ebs = { volume_size = 8 } }, { device_name = "/dev/sdb", virtual_name = "ephemeral0", ebs = {} }, { device_name = "/dev/sdc", virtual_name = "ephemeral1", ebs = {} }] }
  }
  assert {
    condition     = length(aws_launch_template.merchant.block_device_mappings) == 1 && one(aws_launch_template.merchant.block_device_mappings).device_name == "/dev/sda1" && length(one(aws_launch_template.merchant.block_device_mappings).ebs) == 1
    error_message = "Emit only a complete root EBS mapping; never emit bare optional devices."
  }
}

run "reject_instance_store_host" {
  command = plan
  override_data {
    target = data.aws_ec2_instance_type.merchant
    values = { instance_storage_supported = true, memory_size = 16384, default_vcpus = 4, supported_architectures = ["arm64"] }
  }
  expect_failures = [aws_launch_template.merchant]
}

run "reject_wrong_cpu_count" {
  command = plan
  override_data {
    target = data.aws_ec2_instance_type.merchant
    values = { memory_size = 16384, default_vcpus = 8, supported_architectures = ["arm64"] }
  }
  expect_failures = [aws_launch_template.merchant]
}
