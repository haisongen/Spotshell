---
schema_version: 1
id: 33333333-3333-4333-8333-333333333333
kind: environment
name: Production Web
description: Facts for the production web service environment.
tags:
  - production
  - web
modules:
  always:
    - 11111111-1111-4111-8111-111111111111
  on_demand:
    - 22222222-2222-4222-8222-222222222222
---

# Production Web

- Region: cn-east-1
- Service: web-api
- Log path: `/var/log/web-api/service.log`
