// Generated from commerce-api/rocento-api/openapi.json; do not edit.
export const assistantSchemas: Record<string, unknown> = {
  "AssistantProviderSettings": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "enabled",
      "provider",
      "model",
      "key_configured",
      "source",
      "editable"
    ],
    "properties": {
      "enabled": {
        "type": "boolean"
      },
      "provider": {
        "type": "string"
      },
      "model": {
        "type": "string"
      },
      "key_configured": {
        "type": "boolean"
      },
      "source": {
        "type": "string"
      },
      "editable": {
        "type": "boolean"
      }
    }
  },
  "AssistantProviderInput": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "enabled",
      "model"
    ],
    "properties": {
      "enabled": {
        "type": "boolean"
      },
      "model": {
        "type": "string",
        "minLength": 1,
        "maxLength": 100,
        "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]*$"
      },
      "api_key": {
        "type": "string",
        "maxLength": 512,
        "writeOnly": true,
        "nullable": true
      },
      "clear_key": {
        "type": "boolean",
        "default": false
      }
    }
  },
  "AssistantProviderTest": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "ok",
      "message"
    ],
    "properties": {
      "ok": {
        "type": "boolean"
      },
      "message": {
        "type": "string"
      }
    }
  },
  "AssistantReadinessCheck": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "name",
      "status",
      "message"
    ],
    "properties": {
      "name": {
        "type": "string",
        "enum": [
          "provider",
          "assistant",
          "catalog_tools",
          "tool_schemas",
          "knowledge",
          "storage",
          "commerce_schema"
        ]
      },
      "status": {
        "type": "string",
        "enum": [
          "pass",
          "fail",
          "not_configured"
        ]
      },
      "message": {
        "type": "string",
        "maxLength": 256
      }
    }
  },
  "AssistantAcceptance": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "status",
      "checked_at",
      "configuration_revision",
      "request_reference",
      "message",
      "duration_ms",
      "input_tokens",
      "output_tokens"
    ],
    "properties": {
      "status": {
        "type": "string",
        "enum": [
          "not_run",
          "not_configured",
          "pass",
          "fail",
          "stale"
        ]
      },
      "checked_at": {
        "type": "string",
        "format": "date-time",
        "nullable": true
      },
      "configuration_revision": {
        "type": "string",
        "maxLength": 64,
        "nullable": true
      },
      "request_reference": {
        "type": "string",
        "format": "uuid",
        "nullable": true
      },
      "message": {
        "type": "string",
        "maxLength": 256
      },
      "duration_ms": {
        "type": "integer",
        "minimum": 0,
        "nullable": true
      },
      "input_tokens": {
        "type": "integer",
        "minimum": 0,
        "nullable": true
      },
      "output_tokens": {
        "type": "integer",
        "minimum": 0,
        "nullable": true
      }
    }
  },
  "AssistantReadiness": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "version",
      "tenant_id",
      "enabled",
      "provider_configured",
      "model",
      "configuration_revision",
      "tool_schema_revision",
      "feature_flags",
      "checks",
      "currency_modes",
      "quantity_modes",
      "payment_modes",
      "delivery_modes",
      "knowledge_configured",
      "last_acceptance"
    ],
    "properties": {
      "version": {
        "type": "string",
        "enum": [
          "1"
        ]
      },
      "tenant_id": {
        "type": "string",
        "format": "uuid"
      },
      "enabled": {
        "type": "boolean"
      },
      "provider_configured": {
        "type": "boolean"
      },
      "model": {
        "type": "string",
        "maxLength": 100
      },
      "configuration_revision": {
        "type": "string",
        "maxLength": 64
      },
      "tool_schema_revision": {
        "type": "string",
        "maxLength": 64
      },
      "feature_flags": {
        "type": "array",
        "items": {
          "type": "string",
          "maxLength": 64
        },
        "maxItems": 16
      },
      "checks": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/AssistantReadinessCheck"
        },
        "maxItems": 10
      },
      "currency_modes": {
        "type": "array",
        "items": {
          "type": "string",
          "maxLength": 32
        },
        "maxItems": 10
      },
      "quantity_modes": {
        "type": "array",
        "items": {
          "type": "string",
          "maxLength": 32
        },
        "maxItems": 10
      },
      "payment_modes": {
        "type": "array",
        "items": {
          "type": "string",
          "maxLength": 32
        },
        "maxItems": 10
      },
      "delivery_modes": {
        "type": "array",
        "items": {
          "type": "string",
          "maxLength": 64
        },
        "maxItems": 10
      },
      "knowledge_configured": {
        "type": "boolean"
      },
      "last_acceptance": {
        "$ref": "#/components/schemas/AssistantAcceptance"
      }
    }
  },
  "AssistantAcceptanceInput": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "query"
    ],
    "properties": {
      "query": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      }
    }
  },
  "AssistantTrackingRow": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "request_id",
      "created_at",
      "outcome",
      "latency_ms",
      "conversation_id",
      "route",
      "intent",
      "model",
      "model_calls",
      "input_tokens",
      "output_tokens",
      "question_preview",
      "report_available"
    ],
    "properties": {
      "request_id": {
        "type": "string",
        "format": "uuid"
      },
      "created_at": {
        "type": "string",
        "format": "date-time"
      },
      "outcome": {
        "type": "string"
      },
      "latency_ms": {
        "type": "integer"
      },
      "conversation_id": {
        "type": "string",
        "format": "uuid",
        "nullable": true
      },
      "route": {
        "type": "string"
      },
      "intent": {
        "type": "string",
        "nullable": true
      },
      "model": {
        "type": "string",
        "nullable": true
      },
      "model_calls": {
        "type": "integer"
      },
      "input_tokens": {
        "type": "integer"
      },
      "output_tokens": {
        "type": "integer"
      },
      "question_preview": {
        "type": "string",
        "nullable": true
      },
      "report_available": {
        "type": "boolean"
      }
    }
  },
  "AssistantTrackingList": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "capture_enabled",
      "retention_days",
      "items",
      "next_cursor"
    ],
    "properties": {
      "capture_enabled": {
        "type": "boolean"
      },
      "retention_days": {
        "type": "integer"
      },
      "items": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/AssistantTrackingRow"
        },
        "maxItems": 50
      },
      "next_cursor": {
        "type": "string",
        "nullable": true
      }
    }
  },
  "AssistantTrackingStage": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "stage",
      "data"
    ],
    "properties": {
      "stage": {
        "type": "string"
      },
      "data": {}
    }
  },
  "AssistantTrackingReport": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "version",
      "request_id",
      "truncated",
      "redacted",
      "events"
    ],
    "properties": {
      "version": {
        "type": "integer"
      },
      "request_id": {
        "type": "string",
        "format": "uuid"
      },
      "truncated": {
        "type": "boolean"
      },
      "redacted": {
        "type": "boolean"
      },
      "events": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/AssistantTrackingStage"
        },
        "maxItems": 96
      }
    }
  },
  "AssistantCaptureInput": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "enabled"
    ],
    "properties": {
      "enabled": {
        "type": "boolean"
      }
    }
  },
  "AssistantCaptureStatus": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "enabled",
      "editable",
      "source"
    ],
    "properties": {
      "enabled": {
        "type": "boolean"
      },
      "editable": {
        "type": "boolean"
      },
      "source": {
        "type": "string"
      }
    }
  },
  "AssistantLiveEvent": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "sequence",
      "request_id",
      "kind",
      "data"
    ],
    "properties": {
      "sequence": {
        "type": "integer",
        "minimum": 0
      },
      "request_id": {
        "type": "string",
        "format": "uuid"
      },
      "kind": {
        "type": "string",
        "enum": [
          "stage",
          "finished"
        ]
      },
      "data": {}
    }
  },
  "AssistantLiveBatch": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "cursor",
      "reset",
      "capture_enabled",
      "events"
    ],
    "properties": {
      "cursor": {
        "type": "string"
      },
      "reset": {
        "type": "boolean"
      },
      "capture_enabled": {
        "type": "boolean"
      },
      "events": {
        "type": "array",
        "maxItems": 128,
        "items": {
          "$ref": "#/components/schemas/AssistantLiveEvent"
        }
      }
    }
  },
  "AssistantProductAttribute": {
    "type": "object",
    "properties": {
      "name": {
        "type": "string",
        "maxLength": 100,
        "minLength": 1
      },
      "value": {
        "type": "string",
        "maxLength": 250,
        "minLength": 1
      }
    },
    "required": [
      "name",
      "value"
    ],
    "additionalProperties": false
  },
  "AssistantSource": {
    "type": "object",
    "properties": {
      "kind": {
        "type": "string",
        "enum": [
          "catalog"
        ]
      },
      "product_id": {
        "type": "string",
        "format": "uuid"
      },
      "route": {
        "type": "string",
        "maxLength": 46,
        "minLength": 1,
        "pattern": "^/products/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
      }
    },
    "required": [
      "kind",
      "product_id",
      "route"
    ],
    "additionalProperties": false
  },
  "AssistantProduct": {
    "type": "object",
    "properties": {
      "id": {
        "type": "string",
        "format": "uuid"
      },
      "name": {
        "type": "string",
        "maxLength": 1000,
        "minLength": 1
      },
      "image_id": {
        "type": "string",
        "format": "uuid",
        "nullable": true
      },
      "price": {
        "type": "string",
        "maxLength": 19,
        "minLength": 1,
        "pattern": "^\\d{1,12}(\\.\\d{1,6})?$"
      },
      "currency": {
        "type": "string",
        "maxLength": 3,
        "minLength": 1,
        "pattern": "^[A-Z]{3}$"
      },
      "in_stock": {
        "type": "boolean",
        "nullable": true
      },
      "route": {
        "type": "string",
        "maxLength": 46,
        "minLength": 1,
        "pattern": "^/products/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
      },
      "attributes": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/AssistantProductAttribute"
        },
        "maxItems": 20,
        "minItems": 0
      },
      "reasons": {
        "type": "array",
        "items": {
          "type": "string",
          "maxLength": 350,
          "minLength": 1
        },
        "maxItems": 20,
        "minItems": 0
      },
      "unmet": {
        "type": "array",
        "items": {
          "type": "string",
          "maxLength": 250,
          "minLength": 1
        },
        "maxItems": 20,
        "minItems": 0
      },
      "original_price": {
        "type": "string",
        "maxLength": 19,
        "minLength": 1,
        "pattern": "^\\d{1,12}(\\.\\d{1,6})?$"
      }
    },
    "required": [
      "id",
      "name",
      "image_id",
      "price",
      "currency",
      "in_stock",
      "route",
      "attributes",
      "reasons",
      "unmet"
    ],
    "additionalProperties": false
  },
  "AssistantComparisonRow": {
    "type": "object",
    "properties": {
      "label": {
        "type": "string",
        "maxLength": 100,
        "minLength": 1
      },
      "values": {
        "type": "array",
        "items": {
          "type": "string",
          "maxLength": 250,
          "minLength": 1
        },
        "maxItems": 5,
        "minItems": 2
      }
    },
    "required": [
      "label",
      "values"
    ],
    "additionalProperties": false
  },
  "AssistantAction": {
    "type": "object",
    "properties": {
      "label": {
        "type": "string",
        "maxLength": 100,
        "minLength": 1
      },
      "route": {
        "type": "string",
        "enum": [
          "/search"
        ]
      }
    },
    "required": [
      "label",
      "route"
    ],
    "additionalProperties": false
  },
  "AssistantTransferItem": {
    "type": "object",
    "properties": {
      "name": {
        "type": "string",
        "maxLength": 1000,
        "minLength": 1
      },
      "status": {
        "type": "string",
        "enum": [
          "transferred",
          "not_transferred",
          "not_confirmed"
        ]
      },
      "detail": {
        "type": "string",
        "maxLength": 250,
        "minLength": 1
      }
    },
    "required": [
      "name",
      "status"
    ],
    "additionalProperties": false
  },
  "AssistantWishlistRemove": {
    "type": "object",
    "properties": {
      "product_id": {
        "type": "string",
        "format": "uuid"
      }
    },
    "required": [
      "product_id"
    ],
    "additionalProperties": false
  },
  "AssistantCartRemoval": {
    "type": "object",
    "properties": {
      "product_id": {
        "type": "string",
        "format": "uuid"
      },
      "name": {
        "type": "string",
        "maxLength": 1000,
        "minLength": 1
      },
      "quantity": {
        "type": "integer",
        "minimum": 1,
        "maximum": 1000000
      },
      "remaining_quantity": {
        "type": "integer",
        "minimum": 0,
        "maximum": 1000000
      },
      "cart_quantity": {
        "type": "integer",
        "minimum": 0
      },
      "cart_subtotal": {
        "type": "string",
        "maxLength": 40,
        "minLength": 1
      },
      "currency": {
        "type": "string",
        "maxLength": 3,
        "minLength": 1,
        "pattern": "^[A-Z]{3}$"
      }
    },
    "required": [
      "product_id",
      "name",
      "quantity",
      "remaining_quantity",
      "cart_quantity",
      "cart_subtotal",
      "currency"
    ],
    "additionalProperties": false
  },
  "AssistantCartRemovalChoice": {
    "type": "object",
    "properties": {
      "items": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/AssistantCartItem"
        },
        "maxItems": 5,
        "minItems": 1
      },
      "quantity": {
        "type": "integer",
        "minimum": 1,
        "maximum": 1000000,
        "nullable": true
      }
    },
    "required": [
      "items",
      "quantity"
    ],
    "additionalProperties": false
  },
  "AssistantProductPrompt": {
    "type": "object",
    "properties": {
      "query": {
        "type": "string",
        "maxLength": 120,
        "minLength": 1
      },
      "quantity": {
        "type": "integer",
        "minimum": 1,
        "maximum": 1000000
      },
      "action": {
        "type": "string",
        "enum": [
          "choose",
          "cart",
          "wishlist",
          "compare",
          "remove"
        ]
      }
    },
    "required": [
      "query",
      "quantity",
      "action"
    ],
    "additionalProperties": false
  },
  "AssistantCompoundProduct": {
    "type": "object",
    "properties": {
      "name": {
        "type": "string",
        "maxLength": 1000,
        "minLength": 1
      },
      "sku": {
        "type": "string",
        "maxLength": 200,
        "minLength": 1,
        "pattern": "^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$"
      }
    },
    "required": [
      "name",
      "sku"
    ],
    "additionalProperties": false
  },
  "AssistantCompoundActionChoice": {
    "type": "object",
    "properties": {
      "destination": {
        "type": "string",
        "enum": [
          "cart",
          "wishlist"
        ]
      },
      "quantity": {
        "type": "integer",
        "minimum": 1,
        "maximum": 1000000
      },
      "choices": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/AssistantCompoundProduct"
        },
        "maxItems": 5,
        "minItems": 1
      }
    },
    "required": [
      "destination",
      "quantity",
      "choices"
    ],
    "additionalProperties": false
  },
  "AssistantCompoundChoice": {
    "type": "object",
    "properties": {
      "actions": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/AssistantCompoundActionChoice"
        },
        "maxItems": 2,
        "minItems": 2
      }
    },
    "required": [
      "actions"
    ],
    "additionalProperties": false
  },
  "AssistantBlock": {
    "type": "object",
    "properties": {
      "kind": {
        "type": "string",
        "enum": [
          "text",
          "product_card",
          "product_list",
          "comparison_table",
          "recommendation_group",
          "action",
          "cart_summary",
          "basket_proposal",
          "saved_addresses",
          "wishlist_manage",
          "wishlist_transfer",
          "product_prompt",
          "cart_removal",
          "cart_removal_choice",
          "compound_choice"
        ]
      },
      "text": {
        "type": "string",
        "maxLength": 8000,
        "minLength": 1
      },
      "title": {
        "type": "string",
        "maxLength": 200,
        "minLength": 1
      },
      "products": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/AssistantProduct"
        },
        "maxItems": 8,
        "minItems": 1
      },
      "rows": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/AssistantComparisonRow"
        },
        "maxItems": 24,
        "minItems": 1
      },
      "action": {
        "$ref": "#/components/schemas/AssistantAction"
      },
      "sources": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/AssistantSource"
        },
        "maxItems": 8,
        "minItems": 1
      },
      "cart": {
        "$ref": "#/components/schemas/AssistantCartView"
      },
      "proposal_id": {
        "type": "string",
        "format": "uuid"
      },
      "compound_choice": {
        "$ref": "#/components/schemas/AssistantCompoundChoice"
      },
      "product_prompt": {
        "$ref": "#/components/schemas/AssistantProductPrompt"
      },
      "cart_removal": {
        "$ref": "#/components/schemas/AssistantCartRemoval"
      },
      "cart_removal_choice": {
        "$ref": "#/components/schemas/AssistantCartRemovalChoice"
      },
      "transfer_items": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/AssistantTransferItem"
        },
        "maxItems": 5,
        "minItems": 1
      }
    },
    "required": [
      "kind"
    ],
    "additionalProperties": false
  },
  "AssistantFeedback": {
    "type": "object",
    "properties": {
      "request_id": {
        "type": "string",
        "format": "uuid"
      },
      "helpful": {
        "type": "boolean"
      }
    },
    "required": [
      "request_id",
      "helpful"
    ],
    "additionalProperties": false
  },
  "AssistantHistoryTurn": {
    "type": "object",
    "properties": {
      "response_source": {
        "type": "string",
        "enum": [
          "R",
          "L",
          null
        ],
        "nullable": true
      },
      "conversation_id": {
        "type": "string",
        "format": "uuid"
      },
      "request_id": {
        "type": "string",
        "format": "uuid"
      },
      "question": {
        "type": "string",
        "maxLength": 4000,
        "minLength": 1
      },
      "answer": {
        "type": "string",
        "maxLength": 8000
      },
      "blocks": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/AssistantBlock"
        },
        "maxItems": 8,
        "minItems": 0
      },
      "helpful": {
        "type": "boolean",
        "nullable": true
      },
      "created_at": {
        "type": "string",
        "format": "date-time"
      }
    },
    "required": [
      "conversation_id",
      "request_id",
      "question",
      "answer",
      "created_at"
    ],
    "additionalProperties": false
  },
  "AssistantClarification": {
    "type": "object",
    "properties": {
      "original_message": {
        "type": "string",
        "maxLength": 4000,
        "minLength": 1
      },
      "question": {
        "type": "string",
        "maxLength": 1000,
        "minLength": 1
      },
      "revision": {
        "type": "string",
        "format": "uuid"
      },
      "kind": {
        "type": "string",
        "enum": [
          "shopping"
        ]
      },
      "choices": {
        "type": "array",
        "items": {
          "type": "string",
          "maxLength": 120,
          "minLength": 1
        },
        "maxItems": 8,
        "minItems": 0
      },
      "optional": {
        "type": "boolean"
      }
    },
    "required": [
      "original_message",
      "question"
    ],
    "additionalProperties": false
  },
  "AssistantChatInput": {
    "type": "object",
    "properties": {
      "request_id": {
        "type": "string",
        "format": "uuid"
      },
      "message": {
        "type": "string",
        "maxLength": 4000,
        "minLength": 1
      },
      "order_id": {
        "type": "string",
        "format": "uuid"
      },
      "product_id": {
        "type": "string",
        "format": "uuid"
      },
      "cart_context": {
        "type": "boolean"
      },
      "ticket": {
        "$ref": "#/components/schemas/AssistantTicketInput"
      },
      "conversation_id": {
        "type": "string",
        "format": "uuid"
      },
      "shopping_mode": {
        "type": "string",
        "enum": [
          "shop",
          "optimize",
          "buy_again"
        ]
      },
      "clarification": {
        "$ref": "#/components/schemas/AssistantClarification"
      }
    },
    "required": [
      "request_id",
      "message"
    ],
    "additionalProperties": false
  },
  "AssistantOrderArgs": {
    "type": "object",
    "properties": {
      "order_id": {
        "type": "string",
        "format": "uuid"
      }
    },
    "required": [
      "order_id"
    ],
    "additionalProperties": false
  },
  "AssistantCartItem": {
    "type": "object",
    "properties": {
      "product_id": {
        "type": "string",
        "format": "uuid"
      },
      "name": {
        "type": "string",
        "maxLength": 1000,
        "minLength": 1
      },
      "price": {
        "type": "string",
        "maxLength": 40,
        "minLength": 1
      },
      "currency": {
        "type": "string",
        "maxLength": 3,
        "minLength": 1
      },
      "quantity": {
        "type": "integer",
        "minimum": 1,
        "maximum": 1000000
      },
      "line_total": {
        "type": "string",
        "maxLength": 40,
        "minLength": 1
      }
    },
    "required": [
      "product_id",
      "name",
      "price",
      "currency",
      "quantity",
      "line_total"
    ],
    "additionalProperties": false
  },
  "AssistantCart": {
    "type": "object",
    "properties": {
      "items": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/AssistantCartItem"
        },
        "maxItems": 200,
        "minItems": 0
      },
      "subtotal": {
        "type": "string",
        "maxLength": 40,
        "minLength": 1
      },
      "discount_amount": {
        "type": "string",
        "maxLength": 40,
        "minLength": 1
      },
      "currency": {
        "type": "string",
        "maxLength": 3,
        "minLength": 1
      },
      "fully_reserved": {
        "type": "boolean"
      }
    },
    "required": [
      "items",
      "subtotal",
      "discount_amount",
      "currency",
      "fully_reserved"
    ],
    "additionalProperties": false
  },
  "AssistantCartView": {
    "type": "object",
    "properties": {
      "items": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/AssistantCartItem"
        },
        "maxItems": 200,
        "minItems": 0
      },
      "total_lines": {
        "type": "integer",
        "minimum": 0
      },
      "total_quantity": {
        "type": "integer",
        "minimum": 0
      },
      "subtotal": {
        "type": "string",
        "maxLength": 40,
        "minLength": 1
      },
      "discount_amount": {
        "type": "string",
        "maxLength": 40,
        "minLength": 1
      },
      "currency": {
        "type": "string",
        "maxLength": 3,
        "minLength": 1
      },
      "fully_reserved": {
        "type": "boolean"
      }
    },
    "required": [
      "items",
      "total_lines",
      "total_quantity",
      "subtotal",
      "discount_amount",
      "currency",
      "fully_reserved"
    ],
    "additionalProperties": false
  },
  "AssistantDelivery": {
    "type": "object",
    "properties": {
      "configured": {
        "type": "boolean"
      },
      "deliverable": {
        "type": "boolean"
      },
      "area_id": {
        "type": "string",
        "format": "uuid",
        "nullable": true
      }
    },
    "required": [
      "configured",
      "deliverable",
      "area_id"
    ],
    "additionalProperties": false
  },
  "AssistantShipment": {
    "type": "object",
    "properties": {
      "tracking_reference": {
        "type": "string",
        "maxLength": 500
      },
      "status": {
        "type": "string",
        "maxLength": 50,
        "minLength": 1
      }
    },
    "required": [
      "tracking_reference",
      "status"
    ],
    "additionalProperties": false
  },
  "AssistantOrder": {
    "type": "object",
    "properties": {
      "id": {
        "type": "string",
        "format": "uuid"
      },
      "number": {
        "type": "integer"
      },
      "status": {
        "type": "string",
        "maxLength": 50,
        "minLength": 1
      },
      "subtotal": {
        "type": "string",
        "maxLength": 40,
        "minLength": 1
      },
      "discount_amount": {
        "type": "string",
        "maxLength": 40,
        "minLength": 1
      },
      "tax_amount": {
        "type": "string",
        "maxLength": 40,
        "minLength": 1
      },
      "delivery_fee": {
        "type": "string",
        "maxLength": 40,
        "minLength": 1
      },
      "total": {
        "type": "string",
        "maxLength": 40,
        "minLength": 1
      },
      "currency": {
        "type": "string",
        "maxLength": 3,
        "minLength": 1
      },
      "cancellation_available": {
        "type": "boolean"
      },
      "shipments": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/AssistantShipment"
        },
        "maxItems": 100
      }
    },
    "required": [
      "id",
      "number",
      "status",
      "subtotal",
      "discount_amount",
      "tax_amount",
      "delivery_fee",
      "total",
      "currency",
      "cancellation_available",
      "shipments"
    ],
    "additionalProperties": false
  },
  "AssistantSavedLocation": {
    "type": "object",
    "properties": {
      "id": {
        "type": "string",
        "format": "uuid"
      },
      "label": {
        "type": "string",
        "maxLength": 100,
        "minLength": 1
      },
      "formatted_address": {
        "type": "string",
        "maxLength": 1000,
        "minLength": 1
      },
      "is_default": {
        "type": "boolean"
      },
      "entity_id": {
        "type": "integer",
        "format": "int64",
        "minimum": 1,
        "maximum": 9007199254740991,
        "readOnly": true,
        "description": "Server-assigned, immutable entity number unique within this entity type. UUID id remains the API and relationship identity."
      }
    },
    "required": [
      "id",
      "label",
      "formatted_address",
      "is_default"
    ],
    "additionalProperties": false
  },
  "AssistantTicketInput": {
    "type": "object",
    "properties": {
      "request_id": {
        "type": "string",
        "format": "uuid"
      },
      "subject": {
        "type": "string",
        "maxLength": 160,
        "minLength": 1
      },
      "category": {
        "type": "string",
        "enum": [
          "order_issue",
          "product_question",
          "complaint",
          "payment_dispute",
          "other"
        ]
      },
      "body": {
        "type": "string",
        "maxLength": 2000,
        "minLength": 1
      },
      "order_id": {
        "type": "string",
        "format": "uuid"
      },
      "contact_name": {
        "type": "string",
        "maxLength": 100,
        "minLength": 1
      },
      "contact": {
        "type": "string",
        "maxLength": 254,
        "minLength": 1
      }
    },
    "required": [
      "request_id",
      "subject",
      "category",
      "body"
    ],
    "additionalProperties": false
  },
  "AssistantTicket": {
    "type": "object",
    "properties": {
      "id": {
        "type": "string",
        "format": "uuid"
      },
      "number": {
        "type": "integer"
      },
      "subject": {
        "type": "string",
        "maxLength": 160,
        "minLength": 1
      },
      "category": {
        "type": "string",
        "enum": [
          "order_issue",
          "product_question",
          "complaint",
          "payment_dispute",
          "other"
        ]
      },
      "status": {
        "type": "string",
        "enum": [
          "open",
          "in_progress",
          "resolved",
          "closed"
        ]
      },
      "priority": {
        "type": "string",
        "enum": [
          "normal",
          "high"
        ]
      },
      "order_id": {
        "type": "string",
        "format": "uuid",
        "nullable": true
      },
      "created_at": {
        "type": "string",
        "format": "date-time"
      },
      "entity_id": {
        "type": "integer",
        "format": "int64",
        "minimum": 1,
        "maximum": 9007199254740991,
        "readOnly": true,
        "description": "Server-assigned, immutable entity number unique within this entity type. UUID id remains the API and relationship identity."
      }
    },
    "required": [
      "id",
      "number",
      "subject",
      "category",
      "status",
      "priority",
      "order_id",
      "created_at"
    ],
    "additionalProperties": false
  },
  "AssistantTicketMessage": {
    "type": "object",
    "properties": {
      "id": {
        "type": "string",
        "format": "uuid"
      },
      "sender": {
        "type": "string",
        "enum": [
          "customer",
          "admin",
          "assistant_summary"
        ]
      },
      "body": {
        "type": "string",
        "maxLength": 2000,
        "minLength": 1
      },
      "created_at": {
        "type": "string",
        "format": "date-time"
      },
      "entity_id": {
        "type": "integer",
        "format": "int64",
        "minimum": 1,
        "maximum": 9007199254740991,
        "readOnly": true,
        "description": "Server-assigned, immutable entity number unique within this entity type. UUID id remains the API and relationship identity."
      }
    },
    "required": [
      "id",
      "sender",
      "body",
      "created_at"
    ],
    "additionalProperties": false
  },
  "AssistantTicketDetail": {
    "type": "object",
    "properties": {
      "ticket": {
        "$ref": "#/components/schemas/AssistantTicket"
      },
      "messages": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/AssistantTicketMessage"
        }
      },
      "contact_name": {
        "type": "string",
        "maxLength": 100,
        "minLength": 1,
        "nullable": true
      },
      "contact": {
        "type": "string",
        "maxLength": 254,
        "minLength": 1,
        "nullable": true
      }
    },
    "required": [
      "ticket",
      "messages",
      "contact_name",
      "contact"
    ],
    "additionalProperties": false
  },
  "AssistantReply": {
    "type": "object",
    "properties": {
      "request_id": {
        "type": "string",
        "format": "uuid"
      },
      "body": {
        "type": "string",
        "maxLength": 2000,
        "minLength": 1
      },
      "status": {
        "type": "string",
        "enum": [
          "open",
          "in_progress",
          "resolved",
          "closed"
        ]
      }
    },
    "required": [
      "request_id",
      "body"
    ],
    "additionalProperties": false
  },
  "AssistantFailure": {
    "type": "object",
    "properties": {
      "code": {
        "type": "string",
        "enum": [
          "provider_timeout",
          "provider_rate_limit",
          "tool_unavailable",
          "catalog_failure",
          "stale_proposal",
          "invalid_provider_response",
          "authentication_needed",
          "unsupported_action",
          "internal_failure"
        ]
      },
      "message": {
        "type": "string",
        "maxLength": 400,
        "minLength": 1
      },
      "retryable": {
        "type": "boolean"
      },
      "recovery": {
        "type": "string",
        "enum": [
          "retry",
          "sign_in",
          "refresh_proposal",
          "browse_catalog",
          "contact_support"
        ]
      },
      "request_reference": {
        "type": "string",
        "format": "uuid"
      }
    },
    "required": [
      "code",
      "message",
      "retryable",
      "recovery",
      "request_reference"
    ],
    "additionalProperties": false
  },
  "AssistantEvent": {
    "type": "object",
    "properties": {
      "response_source": {
        "type": "string",
        "enum": [
          "R",
          "L"
        ]
      },
      "version": {
        "type": "string",
        "enum": [
          "1"
        ]
      },
      "request_id": {
        "type": "string",
        "format": "uuid"
      },
      "sequence": {
        "type": "integer",
        "minimum": 0
      },
      "type": {
        "type": "string",
        "enum": [
          "message.delta",
          "card.order",
          "ticket.created",
          "progress",
          "content.blocks",
          "error",
          "done"
        ]
      },
      "clarification": {
        "$ref": "#/components/schemas/AssistantClarification"
      },
      "saved": {
        "type": "boolean"
      },
      "failure": {
        "$ref": "#/components/schemas/AssistantFailure"
      },
      "blocks": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/AssistantBlock"
        },
        "maxItems": 8,
        "minItems": 1
      },
      "stage": {
        "type": "string",
        "enum": [
          "preparing",
          "catalog",
          "order",
          "support",
          "responding"
        ]
      },
      "text": {
        "type": "string",
        "maxLength": 8000,
        "minLength": 1
      },
      "order": {
        "$ref": "#/components/schemas/AssistantOrder"
      },
      "ticket": {
        "$ref": "#/components/schemas/AssistantTicketDetail"
      },
      "code": {
        "type": "string",
        "enum": [
          "login_required",
          "unavailable",
          "area_unavailable",
          "open_address_form",
          "open_checkout",
          "clear_comparison",
          "unknown",
          "support_required"
        ]
      }
    },
    "required": [
      "version",
      "request_id",
      "sequence",
      "type"
    ],
    "additionalProperties": false
  },
  "AssistantModelUsage": {
    "type": "object",
    "properties": {
      "provider": {
        "type": "string",
        "maxLength": 100,
        "minLength": 1
      },
      "model": {
        "type": "string",
        "maxLength": 100,
        "minLength": 1
      },
      "input_tokens": {
        "type": "integer",
        "minimum": 0
      },
      "output_tokens": {
        "type": "integer",
        "minimum": 0
      },
      "turns": {
        "type": "integer",
        "minimum": 0
      }
    },
    "required": [
      "provider",
      "model",
      "input_tokens",
      "output_tokens",
      "turns"
    ],
    "additionalProperties": false
  },
  "AssistantRouteUsage": {
    "type": "object",
    "properties": {
      "route": {
        "type": "string",
        "maxLength": 100,
        "minLength": 1
      },
      "turns": {
        "type": "integer",
        "minimum": 0
      }
    },
    "required": [
      "route",
      "turns"
    ],
    "additionalProperties": false
  },
  "AssistantUsage": {
    "type": "object",
    "properties": {
      "turns": {
        "type": "integer",
        "minimum": 0
      },
      "conversations": {
        "type": "integer",
        "minimum": 0
      },
      "errors": {
        "type": "integer",
        "minimum": 0
      },
      "helpful": {
        "type": "integer",
        "minimum": 0
      },
      "not_helpful": {
        "type": "integer",
        "minimum": 0
      },
      "input_tokens": {
        "type": "integer",
        "minimum": 0
      },
      "output_tokens": {
        "type": "integer",
        "minimum": 0
      },
      "tool_calls": {
        "type": "integer",
        "minimum": 0
      },
      "retrieval_count": {
        "type": "integer",
        "minimum": 0
      },
      "usage_recorded": {
        "type": "integer",
        "minimum": 0
      },
      "model_calls": {
        "type": "integer",
        "minimum": 0
      },
      "estimated_cost_micros": {
        "type": "integer",
        "minimum": 0
      },
      "cost_recorded": {
        "type": "integer",
        "minimum": 0
      },
      "latency_ms": {
        "type": "number"
      },
      "models": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/AssistantModelUsage"
        },
        "maxItems": 10,
        "minItems": 0
      },
      "routes": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/AssistantRouteUsage"
        },
        "maxItems": 10,
        "minItems": 0
      }
    },
    "required": [
      "turns",
      "conversations",
      "errors",
      "helpful",
      "not_helpful",
      "input_tokens",
      "output_tokens",
      "tool_calls",
      "retrieval_count",
      "usage_recorded",
      "model_calls",
      "estimated_cost_micros",
      "cost_recorded",
      "latency_ms",
      "models",
      "routes"
    ],
    "additionalProperties": false
  },
  "AssistantDeliveryEvent": {
    "type": "object",
    "properties": {
      "conversation_id": {
        "type": "string",
        "format": "uuid"
      },
      "request_id": {
        "type": "string",
        "format": "uuid"
      },
      "location_id": {
        "type": "string",
        "format": "uuid"
      }
    },
    "required": [
      "conversation_id",
      "request_id",
      "location_id"
    ],
    "additionalProperties": false
  },
  "AssistantEventSaved": {
    "type": "object",
    "properties": {
      "saved": {
        "type": "boolean"
      }
    },
    "required": [
      "saved"
    ],
    "additionalProperties": false
  },
  "AssistantHttpError": {
    "type": "object",
    "properties": {
      "error": {
        "type": "string",
        "maxLength": 400,
        "minLength": 1
      },
      "failure": {
        "$ref": "#/components/schemas/AssistantFailure"
      }
    },
    "required": [
      "error"
    ],
    "additionalProperties": false
  },
  "AssistantReport": {
    "type": "object",
    "properties": {
      "configured": {
        "type": "boolean"
      },
      "window_hours": {
        "type": "integer"
      },
      "evaluated_at": {
        "type": "string",
        "format": "date-time"
      },
      "total": {
        "type": "integer",
        "minimum": 0
      },
      "completed": {
        "type": "integer",
        "minimum": 0
      },
      "unavailable": {
        "type": "integer",
        "minimum": 0
      },
      "disconnected": {
        "type": "integer",
        "minimum": 0
      },
      "average_latency_ms": {
        "type": "number",
        "nullable": true
      }
    },
    "required": [
      "configured",
      "window_hours",
      "evaluated_at",
      "total",
      "completed",
      "unavailable",
      "disconnected",
      "average_latency_ms"
    ],
    "additionalProperties": false
  }
};
