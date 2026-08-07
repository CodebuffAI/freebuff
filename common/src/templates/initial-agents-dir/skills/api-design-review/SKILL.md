---
name: api-design-review
description: A structured guide for reviewing and designing RESTful and RPC-style APIs, covering endpoints, schemas, error handling, and best practices
license: MIT
metadata:
  category: development
  audience: developers
---

# API Design Review

A structured guide for reviewing API designs, endpoints, and schemas.

## When to use

Use this skill when asked to review API endpoints, design new APIs, or evaluate API schemas and contracts.

## Review Checklist

### 1. Naming & Consistency

- Are endpoint paths **plural nouns** (`/users`, `/orders`) not verbs (`/getUsers`, `/createOrder`)?
- Are URL segments **kebab-case** or **snake_case** consistently?
- Are query parameters consistently named (camelCase or snake_case)?
- Do related resources follow a consistent pattern (`/users/:id/orders` not `/orders?userId=:id`)?
- Is the API versioned (`/v1/`) in the URL path or header?

### 2. RESTful Design

- Are HTTP methods used correctly? (GET = read, POST = create, PUT = replace, PATCH = update, DELETE = remove)
- Are status codes meaningful? (200 OK, 201 Created, 204 No Content, 400 Bad Request, 401 Unauthorized, 403 Forbidden, 404 Not Found, 409 Conflict, 422 Unprocessable, 500 Server Error)
- Are responses consistent in structure across all endpoints?
- Are list endpoints paginated with consistent params (`page`, `limit`, `cursor`)?
- Are nested resources kept shallow (max 2-3 levels deep)?

### 3. Request/Response Schemas

- Are request bodies validated with consistent error messages?
- Are response fields using **camelCase** for JSON APIs?
- Are date/time fields using **ISO 8601** format?
- Are IDs opaque strings (UUIDs) rather than sequential integers?
- Are sensitive fields (passwords, tokens) excluded from responses?
- Is there a consistent envelope for paginated responses (`{ data, meta: { total, page, limit } }`)?

### 4. Error Handling

- Is there a consistent error response format (`{ error: { code, message, details } }`)?
- Are error messages human-readable and actionable?
- Are internal error details (stack traces, SQL queries) hidden from responses?
- Are rate limiting headers present (`X-RateLimit-Limit`, `X-RateLimit-Remaining`, `Retry-After`)?

### 5. Security

- Is authentication required for all endpoints unless explicitly public?
- Are authorization checks performed per resource, not just at the endpoint level?
- Are input sanitization and validation applied?
- Is HTTPS enforced?
- Are CORS headers properly configured?

### 6. API Documentation

- Is there an OpenAPI/Swagger specification?
- Are there clear examples for each endpoint?
- Are error scenarios documented?
- Are deprecation policies documented?

## Quick Reference

```typescript
// Good RESTful endpoint design
GET    /v1/users              // List users (paginated)
POST   /v1/users              // Create user
GET    /v1/users/:id          // Get user by ID
PATCH  /v1/users/:id          // Update user
DELETE /v1/users/:id          // Delete user
GET    /v1/users/:id/orders   // List user's orders (nested resource)

// Consistent error format
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Email is required",
    "details": {
      "field": "email",
      "constraint": "required"
    }
  }
}

// Consistent paginated response
{
  "data": [...],
  "meta": {
    "total": 100,
    "page": 1,
    "limit": 20,
    "hasMore": true
  }
}
```

## Output Format

Summarize findings as:

- 🔴 **Breaking**: Incompatible change or security issue
- 🟡 **Warning**: Should address before shipping
- 🟢 **Suggestion**: Best practice improvement
- ✅ **Praise**: Something done well

## Quick Reference Commands

- `read_files` — Read the API spec or endpoint files
- `code_search` — Find related endpoints or usage patterns
- `web_search` — Research API design standards or conventions

## Notes

- Design for your consumers, not your data model
- Consistency beats cleverness every time
- A good API is boring — predictable, simple, and hard to misuse
