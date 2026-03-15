# Persona Generation Prompt

Generate Value Proposition Canvas personas for the target users of this project.

## Input

The user has described their target users in natural language. Use this description to:

1. **Research the competitive landscape** using WebSearch:
   - Search for existing tools these users currently use
   - Find common pain points and frustrations in forums (Reddit, HN, product reviews)
   - Identify feature gaps in competitor products
   - Understand workflow patterns and daily routines

2. **Generate a detailed VPC persona** for each user type that includes:

### Profile
- **Nickname + Role**: A memorable name and short role description
- **Age range**: Typical demographic
- **Key behaviors**: 4-5 bullet points describing how they work/interact with tools
- **Tools currently used**: List of specific competitor products/tools
- **Spending pattern**: If relevant (monthly spend, budget constraints)
- **Mindset**: How they think about the problem space

### Value Proposition Canvas

#### Customer Jobs (6-8 entries)
| Type | Job |
|------|-----|
| **Functional** | Concrete tasks they need to accomplish |
| **Social** | How they want to be perceived by others |
| **Emotional** | How they want to feel |

#### Pains (6-8 entries, graded by severity)
| Severity | Pain |
|----------|------|
| **Critical** | Major blockers — things that cause real frustration or wasted time |
| **High** | Significant issues that affect daily workflow |
| **Medium** | Annoyances that are tolerable but reduce satisfaction |
| **Low** | Minor inconveniences |

#### Gains (6-8 entries, graded by impact)
| Impact | Gain |
|--------|------|
| **High** | Game-changing improvements that would make them switch tools |
| **Medium** | Meaningful improvements to their workflow |
| **Low** | Nice-to-haves |

### Key Insight
> The single most important unmet need that this project can uniquely address. This should be the intersection of a critical pain + a high-impact gain that no competitor handles well.

### Sources
List the actual URLs used during research (competitive analysis, forums, reviews, documentation).

## Quality Criteria

- **Grounded in research**: Every pain and gain should be traceable to real user feedback, not assumptions
- **Specific, not generic**: "Spending 30 minutes swapping cards between decks" > "Managing multiple decks is hard"
- **Actionable**: Each pain/gain should suggest a potential feature
- **Differentiated**: Personas should have meaningfully different needs — if they're too similar, merge them
- **Realistic**: Don't invent fantasy users — base on actual market segments
