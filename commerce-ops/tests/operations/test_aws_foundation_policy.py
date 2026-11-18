"""Offline authorization cases against Terraform's rendered mock-plan policy.

This deliberately supports only the operators emitted by this policy; it is not
an AWS IAM simulator. AWS's live context keys and attached policies still need
Access Analyzer, simulation and an authorized canary before activation.
"""
import copy
import fnmatch
import json
import os
from pathlib import Path
import unittest


def sequence(value):
    return value if isinstance(value, list) else [value]


def matches(statement, action, resource, context):
    if not any(fnmatch.fnmatchcase(action.lower(), a.lower()) for a in sequence(statement['Action'])):
        return False
    if not any(fnmatch.fnmatchcase(resource, r) for r in sequence(statement['Resource'])):
        return False
    for operator, clauses in statement.get('Condition', {}).items():
        for key, expected in clauses.items():
            values = sequence(context.get(key, []))
            expected = sequence(expected)
            if operator == 'ForAllValues:StringEquals':
                ok = all(v in expected for v in values)
            elif operator in ('StringEquals', 'ArnEquals', 'Bool'):
                ok = any(str(v).lower() == str(e).lower() if operator == 'Bool' else v == e for v in values for e in expected)
            elif operator == 'StringLike':
                ok = any(fnmatch.fnmatchcase(v, e) for v in values for e in expected)
            elif operator == 'NumericEquals':
                ok = any(float(v) == float(e) for v in values for e in expected)
            elif operator == 'NumericLessThanEquals':
                ok = any(float(v) <= float(e) for v in values for e in expected)
            else:
                raise AssertionError('Unreviewed IAM operator: ' + operator)
            if not ok:
                return False
    return True


class FoundationPolicyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        path = os.environ.get('AWS_FOUNDATION_PLAN_JSON')
        if not path:
            raise unittest.SkipTest('Set AWS_FOUNDATION_PLAN_JSON to terraform test -json -verbose output')
        events = [json.loads(line) for line in Path(path).read_text().splitlines()]
        if not any(e.get('type') == 'test_summary' and e['test_summary']['status'] == 'pass' for e in events):
            raise AssertionError('Terraform tests did not complete successfully')
        plan = next(e['test_plan'] for e in events if e.get('type') == 'test_plan' and e.get('@testrun') == 'secure_foundation_and_scoped_policy')
        cls.policy = json.loads(plan['output_changes']['provisioning_policy_json']['after'])
        cls.ec2 = 'arn:aws:ec2:eu-central-1:111122223333:'
        cls.template = cls.ec2 + 'launch-template/lt-0123456789abcdef0'
        cls.host = '11111111-1111-4111-8111-111111111111'
        cls.state = 'arn:aws:s3:::fixture-merchant-state/merchant-fleet/onboarding-test/aws/' + cls.host + '.tfstate'
        cls.context = {
            'aws:RequestedRegion': 'eu-central-1', 'ec2:LaunchTemplate': cls.template,
            'ec2:IsLaunchTemplateResource': 'true', 'ec2:InstanceType': 't4g.xlarge',
            'ec2:MetadataHttpTokens': 'required', 'ec2:MetadataHttpPutResponseHopLimit': '1',
            'ec2:Tenancy': 'default', 'ec2:InstanceMarketType': 'on-demand',
            'aws:RequestTag/rocento-host': cls.host, 'aws:RequestTag/Name': 'merchant-' + cls.host,
            'ec2:Encrypted': 'true', 'ec2:VolumeType': 'gp3', 'ec2:VolumeSize': '100',
            'ec2:CreateAction': 'RunInstances', 'aws:TagKeys': ['Name', 'rocento-host'],
            'ec2:ResourceTag/rocento-host': cls.host, 'ec2:ResourceTag/Name': 'merchant-' + cls.host,
            's3:ResourceAccount': '111122223333', 's3:prefix': 'merchant-fleet/onboarding-test/aws/'
        }

    def allowed(self, action, resource, context=None):
        matched = [s['Effect'] for s in self.policy['Statement'] if matches(s, action, resource, self.context if context is None else context)]
        return 'Allow' in matched and 'Deny' not in matched

    def test_expected_launch_resources(self):
        resources = [self.template, 'arn:aws:ec2:eu-central-1::image/ami-0123456789abcdef0']
        resources += [self.ec2 + r for r in ['instance/i-0123456789abcdef0', 'volume/vol-0123456789abcdef0', 'network-interface/eni-0123456789abcdef0', 'subnet/subnet-0123456789abcdef0', 'security-group/sg-0123456789abcdef0']]
        for resource in resources:
            with self.subTest(resource=resource):
                self.assertTrue(self.allowed('ec2:RunInstances', resource))
                ctx = dict(self.context, **{'aws:RequestedRegion': 'us-east-1'})
                self.assertFalse(self.allowed('ec2:RunInstances', resource, ctx))
                if resource != self.template:
                    for template in (None, self.template + '-other'):
                        ctx = dict(self.context)
                        ctx.pop('ec2:LaunchTemplate')
                        if template: ctx['ec2:LaunchTemplate'] = template
                        self.assertFalse(self.allowed('ec2:RunInstances', resource, ctx))

    def test_launch_overrides_denied(self):
        for resource, key, bad in [
            ('instance/i-test','ec2:InstanceType','m5.24xlarge'),
            ('instance/i-test','ec2:MetadataHttpTokens','optional'),
            ('instance/i-test','ec2:MetadataHttpPutResponseHopLimit','2'),
            ('instance/i-test','ec2:Tenancy','dedicated'),
            ('instance/i-test','ec2:InstanceMarketType','spot'),
            ('instance/i-test','aws:RequestTag/rocento-host','bad'),
            ('instance/i-test','aws:RequestTag/Name','unrelated'),
            ('volume/vol-test','ec2:Encrypted','false'),
            ('volume/vol-test','ec2:VolumeType','io2'),
            ('volume/vol-test','ec2:VolumeSize','101'),
            ('network-interface/eni-test','ec2:IsLaunchTemplateResource','false'),
            ('subnet/subnet-0123456789abcdef0','ec2:IsLaunchTemplateResource','false'),
        ]:
            for value in (bad, None):
                with self.subTest(resource=resource, key=key, value=value):
                    ctx = copy.deepcopy(self.context)
                    ctx.pop(key)
                    if value is not None: ctx[key] = value
                    self.assertFalse(self.allowed('ec2:RunInstances', self.ec2 + resource, ctx))
        for resource in ['subnet/subnet-fffffffffffffffff', 'security-group/sg-fffffffffffffffff', 'launch-template/lt-fffffffffffffffff', 'key-pair/foreign']:
            self.assertFalse(self.allowed('ec2:RunInstances', self.ec2 + resource))
        self.assertFalse(self.allowed('ec2:RunInstances','arn:aws:ec2:eu-central-1::image/ami-fffffffffffffffff'))

    def test_no_existing_instance_mutations_or_foundation_admin(self):
        for action in ['ec2:ModifyInstanceAttribute', 'ec2:TerminateInstances', 'ec2:StopInstances', 'ec2:StartInstances', 'ec2:ModifyInstanceMetadataOptions', 'ec2:CreateLaunchTemplateVersion', 'ec2:AuthorizeSecurityGroupIngress', 'iam:PassRole', 'iam:AttachRolePolicy', 's3:DeleteBucket', 's3:PutBucketPolicy', 'kms:Decrypt']:
            for resource in [self.ec2+'instance/i-test', self.template, 'arn:aws:s3:::fixture-merchant-state', '*']:
                with self.subTest(action=action, resource=resource): self.assertFalse(self.allowed(action, resource))

    def test_tagging_and_private_attributes(self):
        instance = self.ec2+'instance/i-test'
        self.assertTrue(self.allowed('ec2:CreateTags', instance))
        for change in [{'ec2:CreateAction':'CreateVolume'}, {'aws:TagKeys':['Name','admin']}]:
            self.assertFalse(self.allowed('ec2:CreateTags', instance, dict(self.context, **change)))
        ctx = dict(self.context);ctx.pop('ec2:CreateAction')
        self.assertFalse(self.allowed('ec2:CreateTags',instance,ctx))
        self.assertTrue(self.allowed('ec2:DescribeInstanceAttribute', instance))
        ctx = dict(self.context);ctx.pop('ec2:ResourceTag/rocento-host')
        self.assertFalse(self.allowed('ec2:DescribeInstanceAttribute',instance,ctx))
        self.assertFalse(self.allowed('ec2:DescribeInstanceAttribute',self.ec2.replace('111122223333','444455556666')+'instance/i-test'))

    def test_state_locks_and_cross_scope_denial(self):
        for action in ['s3:GetObject','s3:PutObject']:
            self.assertTrue(self.allowed(action,self.state))
            for resource in [self.state.replace('/aws/','/gcp/'), self.state.replace('onboarding-test','production'), self.state.replace('fixture-merchant-state','other-bucket'), 'arn:aws:s3:::fixture-merchant-state/foundation/aws/terraform.tfstate']:
                self.assertFalse(self.allowed(action,resource))
            self.assertFalse(self.allowed(action,self.state,dict(self.context,**{'s3:ResourceAccount':'444455556666'})))
        for action in ['s3:GetObject','s3:PutObject','s3:DeleteObject']:
            self.assertTrue(self.allowed(action,self.state+'.tflock'))
        for action in ['s3:DeleteObject','s3:DeleteObjectVersion','s3:GetObjectVersion']:
            self.assertFalse(self.allowed(action,self.state))
        bucket = 'arn:aws:s3:::fixture-merchant-state'
        self.assertTrue(self.allowed('s3:ListBucket',bucket))
        for prefix in ['', 'foundation/', 'merchant-fleet/onboarding-test/gcp/', 'env:/']:
            self.assertFalse(self.allowed('s3:ListBucket',bucket,dict(self.context,**{'s3:prefix':prefix})))


if __name__ == '__main__':
    if not os.environ.get('AWS_FOUNDATION_PLAN_JSON'):
        raise SystemExit('AWS_FOUNDATION_PLAN_JSON is required')
    unittest.main()
