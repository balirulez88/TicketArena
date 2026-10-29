# 29: Upstash `QueueStore` adapter and contract suite

**What to build:** the waiting room behaves the same on Upstash in production as on local Redis in tests, proven by one shared contract suite. Spec: Waiting room; ADR 0010.

**Blocked by:** 28

**Status:** ready-for-agent

- [ ] An Upstash REST adapter implements `QueueStore`, including the Lua scripts.
- [ ] One contract suite runs against both adapters; CI provides an Upstash-compatible HTTP endpoint in front of Redis.
- [ ] AT-42: the contract suite passes for both adapters.
