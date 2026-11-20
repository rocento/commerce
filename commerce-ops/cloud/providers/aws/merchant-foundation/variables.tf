variable "account_id" {
  type = string
  validation {
    condition     = can(regex("^[0-9]{12}$", var.account_id))
    error_message = "Provide the intended twelve-digit AWS account ID."
  }
}
variable "region" {
  type = string
  validation {
    condition     = can(regex("^(af|ap|ca|eu|il|me|mx|sa|us)-(central|east|west|north|south|northeast|northwest|southeast|southwest)-[1-9][0-9]*$", var.region))
    error_message = "Use a commercial AWS region; this root uses arn:aws resources."
  }
}
variable "environment" {
  type = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,30}$", var.environment))
    error_message = "Use a short lowercase environment name."
  }
}
variable "vpc_id" {
  type = string
  validation {
    condition     = can(regex("^vpc-[0-9a-f]{17}$", var.vpc_id))
    error_message = "Supply an existing vpc ID without wildcards."
  }
}
variable "subnet_id" {
  type = string
  validation {
    condition     = can(regex("^subnet-[0-9a-f]{17}$", var.subnet_id))
    error_message = "Supply an existing subnet ID without wildcards."
  }
}
variable "merchant_ami_id" {
  type        = string
  description = "Pinned official Canonical Ubuntu 24.04 AMI ID for the selected region and architecture."
  validation {
    condition     = can(regex("^ami-[0-9a-f]{17}$", var.merchant_ami_id))
    error_message = "Supply an approved merchant AMI ID."
  }
}
variable "instance_type" {
  type = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]*[.][a-z0-9]+$", var.instance_type))
    error_message = "Specify a concrete EC2 instance type without IAM wildcards."
  }
}
variable "controller_ssh_cidr" {
  type = string
  validation {
    condition     = can(cidrnetmask(var.controller_ssh_cidr)) && endswith(var.controller_ssh_cidr, "/32") && var.controller_ssh_cidr != "0.0.0.0/32"
    error_message = "SSH must be restricted to the controller IPv4 address /32."
  }
}
variable "https_proxy_ipv4_cidrs" {
  type        = list(string)
  description = "Reviewed current Cloudflare IPv4 CIDRs. No direct public origin access."
  validation {
    condition     = length(var.https_proxy_ipv4_cidrs) > 0 && length(var.https_proxy_ipv4_cidrs) <= 59 && length(distinct(var.https_proxy_ipv4_cidrs)) == length(var.https_proxy_ipv4_cidrs) && alltrue([for cidr in var.https_proxy_ipv4_cidrs : can(cidrnetmask(cidr)) && try(tonumber(split("/", cidr)[1]) >= 8, false)])
    error_message = "Provide explicit reviewed proxy IPv4 networks with prefixes at least /8."
  }
}
variable "state_bucket_name" {
  type = string
  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$", var.state_bucket_name))
    error_message = "Use a globally unique S3 bucket name containing lowercase letters, digits and hyphens."
  }
}
variable "state_key_prefix" {
  type    = string
  default = "merchant-fleet/onboarding-test"
  validation {
    condition     = can(regex("^merchant-fleet/[a-z0-9][a-z0-9/-]*[a-z0-9]$", var.state_key_prefix)) && !strcontains(var.state_key_prefix, "//") && length(var.state_key_prefix) <= 161
    error_message = "Use a concrete merchant-fleet prefix without wildcards or trailing slash, at most 161 characters."
  }
}
variable "root_volume_gib" {
  type    = number
  default = 100
  validation {
    condition     = var.root_volume_gib >= 100 && var.root_volume_gib <= 1000 && floor(var.root_volume_gib) == var.root_volume_gib
    error_message = "Choose an integer root disk size from 100 to 1000 GiB."
  }
}
