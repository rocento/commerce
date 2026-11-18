locals {
  ec2_arn   = "arn:aws:ec2:${var.region}:${var.account_id}"
  state_arn = "${aws_s3_bucket.state.arn}/${var.state_key_prefix}/aws"
  template_condition = {
    ArnEquals    = { "ec2:LaunchTemplate" = aws_launch_template.merchant.arn }
    StringEquals = { "aws:RequestedRegion" = var.region }
  }
  # Output only: attaching this policy is a separate, reviewed operator action.
  provisioning_policy = {
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "ReadEC2ForTerraformAndReconciliation", Effect = "Allow"
        Action    = ["ec2:DescribeInstances", "ec2:DescribeInstanceTypes", "ec2:DescribeInstanceCreditSpecifications", "ec2:DescribeInstanceStatus", "ec2:DescribeVolumes", "ec2:DescribeImages", "ec2:DescribeTags", "ec2:DescribeNetworkInterfaces", "ec2:DescribeSecurityGroups", "ec2:DescribeSubnets", "ec2:DescribeVpcs", "ec2:DescribeLaunchTemplates", "ec2:DescribeLaunchTemplateVersions"]
        Resource  = "*"
        Condition = { StringEquals = { "aws:RequestedRegion" = var.region } }
      },
      {
        Sid       = "LaunchApprovedExistingResources", Effect = "Allow", Action = "ec2:RunInstances"
        Resource  = ["arn:aws:ec2:${var.region}::image/${var.merchant_ami_id}", "${local.ec2_arn}:subnet/${var.subnet_id}", "${local.ec2_arn}:security-group/${aws_security_group.merchant.id}"]
        Condition = merge(local.template_condition, { Bool = { "ec2:IsLaunchTemplateResource" = "true" } })
      },
      {
        Sid       = "UseApprovedTemplate", Effect = "Allow", Action = "ec2:RunInstances"
        Resource  = aws_launch_template.merchant.arn
        Condition = { StringEquals = { "aws:RequestedRegion" = var.region } }
      },
      {
        Sid      = "CreateMerchantInstance", Effect = "Allow", Action = "ec2:RunInstances"
        Resource = "${local.ec2_arn}:instance/*"
        Condition = {
          ArnEquals     = { "ec2:LaunchTemplate" = aws_launch_template.merchant.arn }
          StringEquals  = { "aws:RequestedRegion" = var.region, "ec2:InstanceType" = var.instance_type, "ec2:MetadataHttpTokens" = "required", "ec2:Tenancy" = "default", "ec2:InstanceMarketType" = "on-demand" }
          StringLike    = { "aws:RequestTag/rocento-host" = "????????-????-????-????-????????????", "aws:RequestTag/Name" = "merchent-???*" }
          NumericEquals = { "ec2:MetadataHttpPutResponseHopLimit" = "1" }
        }
      },
      {
        Sid       = "CreateMerchantNetworkInterface", Effect = "Allow", Action = "ec2:RunInstances"
        Resource  = "${local.ec2_arn}:network-interface/*"
        Condition = merge(local.template_condition, { Bool = { "ec2:IsLaunchTemplateResource" = "true" } })
      },
      {
        Sid      = "CreateEncryptedMerchantDisk", Effect = "Allow", Action = "ec2:RunInstances"
        Resource = "${local.ec2_arn}:volume/*"
        Condition = merge(local.template_condition, {
          Bool                  = { "ec2:Encrypted" = "true" }
          StringEquals          = { "aws:RequestedRegion" = var.region, "ec2:VolumeType" = "gp3" }
          NumericLessThanEquals = { "ec2:VolumeSize" = tostring(var.root_volume_gib) }
        })
      },
      {
        Sid      = "TagOnlyDuringInstanceCreation", Effect = "Allow", Action = "ec2:CreateTags"
        Resource = "${local.ec2_arn}:instance/*"
        Condition = {
          StringEquals                = { "ec2:CreateAction" = "RunInstances", "aws:RequestedRegion" = var.region }
          "ForAllValues:StringEquals" = { "aws:TagKeys" = ["Name", "rocento-host"] }
        }
      },
      {
        Sid      = "ReadMerchantInstanceAttributes", Effect = "Allow", Action = "ec2:DescribeInstanceAttribute"
        Resource = "${local.ec2_arn}:instance/*"
        Condition = {
          StringEquals = { "aws:RequestedRegion" = var.region }
          StringLike   = { "ec2:ResourceTag/rocento-host" = "????????-????-????-????-????????????", "ec2:ResourceTag/Name" = ["merchent-???*", "merchant-????????-????-????-????-????????????"] }
        }
      },
      {
        Sid       = "LocateStateBucket", Effect = "Allow", Action = "s3:GetBucketLocation"
        Resource  = aws_s3_bucket.state.arn
        Condition = { StringEquals = { "s3:ResourceAccount" = var.account_id } }
      },
      {
        Sid       = "ListAWSStatePrefix", Effect = "Allow", Action = "s3:ListBucket"
        Resource  = aws_s3_bucket.state.arn
        Condition = { StringEquals = { "s3:ResourceAccount" = var.account_id }, StringLike = { "s3:prefix" = ["${var.state_key_prefix}/aws/*"] } }
      },
      {
        Sid       = "ReadWriteAWSState", Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject"]
        Resource  = "${local.state_arn}/*.tfstate"
        Condition = { StringEquals = { "s3:ResourceAccount" = var.account_id } }
      },
      {
        Sid       = "ManageAWSStateLocks", Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
        Resource  = "${local.state_arn}/*.tfstate.tflock"
        Condition = { StringEquals = { "s3:ResourceAccount" = var.account_id } }
      }
    ]
  }
}
output "provisioning_policy_json" {
  description = "Scoped controller policy; deliberately not attached by this root."
  value       = jsonencode(local.provisioning_policy)
  precondition {
    condition     = length(jsonencode(local.provisioning_policy)) <= 6144
    error_message = "Rendered policy exceeds the IAM managed policy size limit. Shorten the state prefix."
  }
}
output "fleet_config_fragment" {
  description = "Merge into private fleet.json; retain enabled=false until live validation is approved."
  value = {
    enabled   = false
    terraform = { bucket = aws_s3_bucket.state.id, region = var.region, keyPrefix = var.state_key_prefix }
    providers = { aws = {
      region                = var.region, environment = var.environment, maxHosts = 2, minMemoryGiB = 16
      launchTemplateId      = aws_launch_template.merchant.id
      launchTemplateVersion = tostring(aws_launch_template.merchant.latest_version)
    } }
  }
}
