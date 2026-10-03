// Output of `nerf-watch check --json` on the synthetic logs from scripts/make-demo-data.mjs.
// Regenerate: node scripts/make-demo-data.mjs /tmp/nw-demo && node dist/cli.js check --json --root claude=/tmp/nw-demo/claude/projects --root codex=/tmp/nw-demo/codex/sessions
let demoCheckJSON = #"""
{
  "summary": {
    "alert": 2,
    "warn": 3,
    "info": 0
  },
  "findings": [
    {
      "id": "model-mismatch",
      "severity": "alert",
      "agent": "claude",
      "model": "claude-sonnet-5",
      "requestedModel": "claude-opus-5",
      "trigger": "event",
      "title": "Requested claude-opus-5 but claude-sonnet-5 answered",
      "explanation": "120 of 1,280 main-thread API responses (9.4%) for sessions configured to use claude-opus-5 were served by claude-sonnet-5. If you switched models mid-session or use a mode that routes some turns to another model on purpose, this is expected. Otherwise you got a different model than you chose.",
      "evidence": [
        {
          "label": "requested",
          "versions": [
            "2.1.272"
          ],
          "from": "2026-09-18",
          "to": "2026-09-28",
          "samples": 1280,
          "value": 1280,
          "display": "claude-opus-5"
        },
        {
          "label": "served",
          "versions": [
            "2.1.272"
          ],
          "from": "2026-09-18",
          "to": "2026-09-28",
          "samples": 120,
          "value": 0.09375,
          "display": "claude-sonnet-5 (120 turns)"
        }
      ]
    },
    {
      "id": "cacheCreation-shift",
      "severity": "alert",
      "agent": "claude",
      "model": "claude-opus-5",
      "trigger": "version",
      "title": "Cache-creation tokens per turn jumped after CLI 2.1.272",
      "explanation": "Median cache writes per API call went from 926 to 3,037. Cache writes are billed above the normal input price. A jump usually means the cached prefix is being invalidated and rebuilt more often. The change shows up in 3 of 3 separate workloads (projects) that have enough data on both sides, so it is not explained by a change in what you worked on.",
      "evidence": [
        {
          "label": "before",
          "versions": [
            "2.1.270",
            "2.1.271"
          ],
          "from": "2026-08-23",
          "to": "2026-09-16",
          "samples": 780,
          "value": 926,
          "display": "926"
        },
        {
          "label": "after",
          "versions": [
            "2.1.272"
          ],
          "from": "2026-09-19",
          "to": "2026-10-01",
          "samples": 351,
          "value": 3037,
          "display": "3,037"
        }
      ]
    },
    {
      "id": "cacheHitRate-shift",
      "severity": "warn",
      "agent": "claude",
      "model": "claude-opus-5",
      "trigger": "version",
      "title": "Cache hit rate collapsed after CLI 2.1.272",
      "explanation": "The share of prompt tokens served from cache fell from 97.8% to 80.2%. Uncached tokens cost several times more than cached ones and count harder against rate limits, so this shows up as faster limit exhaustion and higher bills for the same work. The change shows up in 3 of 3 separate workloads (projects) that have enough data on both sides, so it is not explained by a change in what you worked on.",
      "evidence": [
        {
          "label": "before",
          "versions": [
            "2.1.270",
            "2.1.271"
          ],
          "from": "2026-08-23",
          "to": "2026-09-16",
          "samples": 780,
          "value": 0.9783213493087116,
          "display": "97.8%"
        },
        {
          "label": "after",
          "versions": [
            "2.1.272"
          ],
          "from": "2026-09-19",
          "to": "2026-10-01",
          "samples": 351,
          "value": 0.8017685357795631,
          "display": "80.2%"
        }
      ]
    },
    {
      "id": "effort-drop",
      "severity": "warn",
      "agent": "codex",
      "model": "gpt-5.5",
      "trigger": "version",
      "title": "Reasoning effort dropped from high to medium after CLI 0.141.0",
      "explanation": "Most sessions on 0.140.0 started at \"high\" effort; on 0.141.0 most start at \"medium\". Sessions where you changed the effort yourself are not counted. If you did not change the effort setting in your config either, the default changed under you. Lower effort is cheaper and faster but plans less and makes more mistakes on hard tasks.",
      "evidence": [
        {
          "label": "before",
          "versions": [
            "0.140.0"
          ],
          "from": "2026-08-23",
          "to": "2026-09-09",
          "samples": 8,
          "value": 4,
          "display": "high (100% of sessions)"
        },
        {
          "label": "after",
          "versions": [
            "0.141.0"
          ],
          "from": "2026-09-12",
          "to": "2026-10-02",
          "samples": 16,
          "value": 3,
          "display": "medium (100% of sessions)"
        }
      ]
    },
    {
      "id": "contextWindow-drift",
      "severity": "warn",
      "agent": "codex",
      "model": "gpt-5.5",
      "trigger": "time",
      "title": "Context window shrank in the last 7 days with no CLI change (0.141.0)",
      "explanation": "The usable context went from about 353.4k to 258.4k tokens. Long sessions will compact or truncate sooner, and the model sees less of your code at once. The CLI version (0.141.0) and model are the same in both windows, so the change is on the provider side or in how you used the agent.",
      "evidence": [
        {
          "label": "before",
          "versions": [
            "0.141.0"
          ],
          "from": "2026-09-12",
          "to": "2026-09-23",
          "samples": 240,
          "value": 353400,
          "display": "353.4k"
        },
        {
          "label": "after",
          "versions": [
            "0.141.0"
          ],
          "from": "2026-09-26",
          "to": "2026-10-02",
          "samples": 240,
          "value": 258400,
          "display": "258.4k"
        }
      ]
    }
  ]
}
"""#
