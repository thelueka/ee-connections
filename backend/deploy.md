# Backend Deployment Guide

## Architecture

```
You (paste wiki content) → Lambda (Bedrock generates questions) → S3 (hosts questions.json)
                                                                       ↑
                                              EE Connections app fetches on startup
```

## Setup (one-time)

### 1. Create S3 Bucket

```bash
aws s3 mb s3://ee-connections-questions --region us-west-2
```

Enable public read (so the Electron app can fetch without auth):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PublicReadQuestions",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::ee-connections-questions/questions.json"
    }
  ]
}
```

```bash
aws s3api put-bucket-policy --bucket ee-connections-questions --policy file://bucket-policy.json
```

### 2. Upload Initial Questions

```bash
aws s3 cp ../data/questions.json s3://ee-connections-questions/questions.json
```

### 3. Create Lambda

```bash
cd lambda
npm install
zip -r function.zip .
aws lambda create-function \
  --function-name ee-connections-generate \
  --runtime nodejs20.x \
  --handler index.handler \
  --zip-file fileb://function.zip \
  --role arn:aws:iam::YOUR_ACCOUNT_ID:role/ee-connections-lambda-role \
  --timeout 60 \
  --memory-size 256 \
  --environment "Variables={QUESTIONS_BUCKET=ee-connections-questions}" \
  --region us-west-2
```

### 4. Create IAM Role

The Lambda role needs:
- `bedrock:InvokeModel` on Claude model
- `s3:GetObject` and `s3:PutObject` on the questions bucket

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "bedrock:InvokeModel",
      "Resource": "arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-3-sonnet-20240229-v1:0"
    },
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject"],
      "Resource": "arn:aws:s3:::ee-connections-questions/*"
    }
  ]
}
```

### 5. Create Function URL (simplest way to invoke)

```bash
aws lambda create-function-url-config \
  --function-name ee-connections-generate \
  --auth-type NONE \
  --region us-west-2
```

This gives you a URL like: `https://abc123.lambda-url.us-west-2.on.aws/`

## Usage

### Adding Questions from Wiki Content

```bash
curl -X POST https://YOUR_LAMBDA_URL/ \
  -H "Content-Type: application/json" \
  -d '{
    "sourceText": "Paste your Confluence page content here...",
    "numQuestions": 10
  }'
```

Or use the local helper script:

```bash
node feed-questions.mjs "paste or pipe wiki text here"
```

## Updating the Lambda

```bash
cd lambda
npm install
zip -r function.zip .
aws lambda update-function-code \
  --function-name ee-connections-generate \
  --zip-file fileb://function.zip \
  --region us-west-2
```
