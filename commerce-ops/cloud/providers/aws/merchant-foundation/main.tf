terraform {
  required_version = ">= 1.10.0, < 2.0.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.40.0"
    }
  }
  # Bootstrap state must be placed in an ignored, protected local directory.
  backend "local" {}
}
provider "aws" {
  region              = var.region
  allowed_account_ids = [var.account_id]
  default_tags { tags = { Application = "rocento-merchant-foundation", Environment = var.environment } }
}
data "aws_subnet" "merchant" { id = var.subnet_id }
data "aws_ami" "merchant" {
  owners = ["099720109477"] # Canonical, commercial AWS regions
  filter {
    name   = "image-id"
    values = [var.merchant_ami_id]
  }
}
data "aws_ec2_instance_type" "merchant" { instance_type = var.instance_type }
resource "aws_s3_bucket" "state" {
  bucket        = var.state_bucket_name
  force_destroy = false
  lifecycle { prevent_destroy = true }
}
resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id
  versioning_configuration { status = "Enabled" }
}
resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}
resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_ownership_controls" "state" {
  bucket = aws_s3_bucket.state.id
  rule { object_ownership = "BucketOwnerEnforced" }
}
resource "aws_s3_bucket_policy" "state" {
  bucket = aws_s3_bucket.state.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "RequireTLS", Effect = "Deny", Principal = "*", Action = "s3:*"
      Resource  = [aws_s3_bucket.state.arn, "${aws_s3_bucket.state.arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
}
resource "aws_security_group" "merchant" {
  name_prefix = "rocento-${var.environment}-merchant-"
  description = "Merchant fleet: controller SSH and approved HTTPS proxies only"
  vpc_id      = var.vpc_id
  ingress {
    description = "Controller SSH only"
    protocol    = "tcp"
    from_port   = 22
    to_port     = 22
    cidr_blocks = [var.controller_ssh_cidr]
  }
  ingress {
    description = "Approved HTTPS proxies"
    protocol    = "tcp"
    from_port   = 443
    to_port     = 443
    cidr_blocks = var.https_proxy_ipv4_cidrs
  }
  egress {
    description = "Runtime package, registry, DNS, SMTP and application dependencies"
    protocol    = "-1"
    from_port   = 0
    to_port     = 0
    cidr_blocks = ["0.0.0.0/0"]
  }
  lifecycle {
    prevent_destroy = true
    precondition {
      condition     = data.aws_subnet.merchant.vpc_id == var.vpc_id
      error_message = "The existing subnet must belong to the selected VPC."
    }
  }
}
resource "aws_launch_template" "merchant" {
  name_prefix                          = "rocento-${var.environment}-merchant-"
  image_id                             = var.merchant_ami_id
  instance_type                        = var.instance_type
  disable_api_termination              = true
  instance_initiated_shutdown_behavior = "stop"
  update_default_version               = false
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "disabled"
  }
  network_interfaces {
    device_index                = 0
    associate_public_ip_address = true
    delete_on_termination       = true
    subnet_id                   = var.subnet_id
    security_groups             = [aws_security_group.merchant.id]
  }
  block_device_mappings {
    device_name = data.aws_ami.merchant.root_device_name
    ebs {
      encrypted             = true
      volume_type           = "gp3"
      volume_size           = var.root_volume_gib
      delete_on_termination = true
    }
  }
  # EBS-only hosts ignore AMI instance-store mappings. Do not emit empty
  # NoDevice values: the AWS provider omits them, leaving invalid bare devices.
  placement { tenancy = "default" }
  # No instance profile, key pair or user data: fleet supplies unique forced SSH access.
  lifecycle {
    prevent_destroy = true
    precondition {
      condition     = !data.aws_ec2_instance_type.merchant.instance_storage_supported
      error_message = "Merchant hosts require an EBS-only instance type; AMI ephemeral mappings must not allocate local disks."
    }
    precondition {
      condition     = data.aws_ec2_instance_type.merchant.memory_size == 16384 && data.aws_ec2_instance_type.merchant.default_vcpus == 4 && contains(data.aws_ec2_instance_type.merchant.supported_architectures, data.aws_ami.merchant.architecture)
      error_message = "Merchant hosts require 4 vCPUs and 16 GiB RAM and an AMI compatible with the instance architecture."
    }
    precondition {
      condition     = data.aws_ami.merchant.public && data.aws_ami.merchant.state == "available" && startswith(data.aws_ami.merchant.name, "ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-")
      error_message = "Use an available official Canonical Ubuntu 24.04 public AMI, pinned by image ID."
    }
    precondition {
      condition = length([for disk in data.aws_ami.merchant.block_device_mappings : disk if disk.device_name == data.aws_ami.merchant.root_device_name]) == 1 && alltrue([
        for disk in data.aws_ami.merchant.block_device_mappings :
        disk.device_name == data.aws_ami.merchant.root_device_name ? try(disk.ebs.volume_size <= var.root_volume_gib, false) : (can(regex("^ephemeral[0-9]+$", disk.virtual_name)) && length(disk.ebs) == 0)
      ])
      error_message = "Require one root EBS snapshot fitting the root volume; only instance-store mappings may accompany it on an EBS-only host."
    }
    precondition {
      condition     = data.aws_ami.merchant.root_device_type == "ebs" && data.aws_ami.merchant.virtualization_type == "hvm"
      error_message = "Use a tested EBS-backed HVM merchant AMI."
    }
  }
}
