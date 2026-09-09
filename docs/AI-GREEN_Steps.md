# AI Environment Recovery: Red to Green

When the AI Elastic Beanstalk environment (`suchanaai-ai-prod`) is stuck Red/Severe and caught in a deploy loop, follow these steps.

## Why It Goes Red

The AI service downloads a ~1 GB embedding model on cold start (30-90s warmup). During this time:

- The ALB health check (`/health` on port 80) may timeout
- EB enhanced health counts upstream LLM 429s / slow Qdrant as 5xx errors
- With low traffic (~6-18 req/min), one failed request = "100% error rate"
- EB marks the instance unhealthy, replaces it, new instance hits the same warmup, repeat

## Step 1: Stop the Abort/Deploy Loop

If the environment is stuck in `Aborting` or `Updating` and won't reach `Ready`:

```bash
# Get the instance ID
aws elasticbeanstalk describe-instances-health \
  --environment-name suchanaai-ai-prod \
  --query 'InstanceHealthList[0].InstanceId' --output text

# Reboot it to force the stuck deploy step to complete
aws ec2 reboot-instances --instance-ids <INSTANCE_ID>
```

Wait ~60 seconds. The environment should transition to `Ready`.

## Step 2: Apply Tolerant Health Config

Once the environment status is `Ready`:

```bash
aws elasticbeanstalk update-environment \
  --environment-name suchanaai-ai-prod \
  --option-settings \
    Namespace=aws:elasticbeanstalk:environment:process:default,OptionName=UnhealthyThresholdCount,Value=10 \
    Namespace=aws:elasticbeanstalk:environment:process:default,OptionName=HealthCheckInterval,Value=15 \
    Namespace=aws:elasticbeanstalk:environment:process:default,OptionName=HealthCheckTimeout,Value=10 \
    Namespace=aws:elasticbeanstalk:command,OptionName=IgnoreHealthCheck,Value=true
```

What each setting does:

| Setting | Old | New | Effect |
|---------|-----|-----|--------|
| UnhealthyThresholdCount | 5 | 10 | 10 failed checks before unhealthy (150s grace) |
| HealthCheckInterval | 30s | 15s | Faster recovery detection once healthy |
| HealthCheckTimeout | 15s | 10s | Tighter per-check timeout (no wasted wait) |
| IgnoreHealthCheck | false | true | Deploys don't stall on transient Red |

## Step 3: Verify

The environment should go Green within ~45 seconds:

```bash
aws elasticbeanstalk describe-environments \
  --environment-name suchanaai-ai-prod \
  --query 'Environments[0].[Status,Health,HealthStatus]' --output table
```

Expected output:

```
+--------+--------+------+
| Ready  | Green  | Ok   |
+--------+--------+------+
```

## Permanent Fix (Already in CI/CD)

The deploy action (`.github/actions/deploy-beanstalk/action.yml`) has a `health-check-grace-period` input. The AI deploy in `ci-cd.yml` passes `health-check-grace-period: "120"`, which generates `.ebextensions/healthcheck.config` in every deploy zip — so these settings persist across all future deploys automatically.

## Quick Reference

```bash
# Check all environments at a glance
aws elasticbeanstalk describe-environments --application-name suchanaai \
  --query 'Environments[*].[EnvironmentName,Status,Health]' --output table

# Check instance-level health
aws elasticbeanstalk describe-instances-health \
  --environment-name suchanaai-ai-prod \
  --query 'InstanceHealthList[*].[InstanceId,HealthStatus,Causes[0]]' --output table

# View recent events (troubleshooting)
aws elasticbeanstalk describe-events \
  --environment-name suchanaai-ai-prod --max-items 10 \
  --query 'Events[*].[EventDate,Severity,Message]' --output table
```
