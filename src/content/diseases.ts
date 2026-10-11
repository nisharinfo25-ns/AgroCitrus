/**
 * Disease reference content.
 *
 * Content is keyed by the class slugs produced by `ml/citrusguard/dataset/classes.py`,
 * which are derived from the classes actually discovered in the published
 * dataset. Entries are general, publicly documented horticultural information.
 *
 * Two rules are enforced by review, not by code, and are stated on every card:
 *   1. no specific pesticide, dose or product is named;
 *   2. treatment decisions are deferred to a local agricultural extension
 *      officer, because registered products and label approvals vary by country.
 *
 * The `migrated` migration seeds these rows. Nothing here is generated at
 * request time, and no entry is invented for a class the dataset lacks.
 */

export interface DiseaseEntry {
  slug: string;
  displayName: string;
  appliesTo: Array<"leaf" | "fruit">;
  isHealthy: boolean;
  shortDescription: string;
  symptoms: string[];
  prevention: string[];
  management: string[];
  references: string[];
}

export const DISEASE_CONTENT: Record<string, DiseaseEntry> = {
  "black-spot": {
    slug: "black-spot",
    displayName: "Black Spot",
    appliesTo: ["leaf", "fruit"],
    isHealthy: false,
    shortDescription:
      "A fungal disease that produces dark, roughly circular lesions on leaves and fruit. On leaves the spots are typically surrounded by a yellow halo; on fruit the rind shows raised, dark, velvety lesions.",
    symptoms: [
      "Round to irregular dark brown or black spots on the upper leaf surface",
      "A yellow halo (chlorotic margin) around many leaf spots",
      "Spots may merge into larger blotches as the disease progresses",
      "Affected leaves turn yellow and drop prematurely (defoliation)",
      "On fruit, dark raised lesions with a rough, sandpaper-like texture",
      "Premature fruit drop and reduced fruit quality when infection is heavy",
    ],
    prevention: [
      "Prune and destroy infected leaves and dead twigs; do not leave infected debris in the orchard",
      "Improve air circulation by keeping the canopy open with regular pruning",
      "Avoid overhead irrigation and keep water off the foliage; irrigate at the base instead",
      "Mulch under trees to reduce soil splash onto lower leaves and fruit",
      "Remove fallen leaves and fruit from the orchard floor during the dormant season",
      "Use disease-free nursery stock and disinfect pruning tools between trees",
    ],
    management: [
      "Start with a confirmed diagnosis from a local extension service before acting",
      "Where a registered fungicide is recommended locally, apply it on a label-approved schedule beginning early in the disease cycle",
      "Alternate or rotate labelled active ingredients to slow resistance development",
      "Remove and destroy heavily infected tissue; fungicides protect new growth, they do not repair existing lesions",
      "Keep trees adequately watered and mulched to reduce stress-related susceptibility",
    ],
    references: [
      "Local agricultural extension service publications for your region",
      "FAO and national plant-protection department citrus disease guides",
    ],
  },

  canker: {
    slug: "canker",
    displayName: "Canker",
    appliesTo: ["leaf", "fruit"],
    isHealthy: false,
    shortDescription:
      "A contagious bacterial disease. It forms raised, corky, crater-like lesions on leaves, fruit and twigs, often with a yellow halo on the leaf. It spreads mainly through wind-driven rain and is aggravated by citrus leafminer feeding.",
    symptoms: [
      "Raised, corky or crater-like lesions with a tan or grey centre",
      "A distinct yellow halo surrounding lesions on leaves",
      "Lesions visible on both sides of the leaf",
      "Rough, raised pustule-like spots on fruit, sometimes cracking as the fruit grows",
      "Lesions on young twigs and, in severe cases, dieback of small branches",
      "Defoliation and premature fruit drop when infection is heavy",
    ],
    prevention: [
      "Plant certified disease-free nursery stock; canker spreads readily through infected propagative material",
      "Prune infected twigs during dry weather and sterilise tools between cuts",
      "Manage citrus leafminer, since leafminer-created wounds are a major entry point for the bacteria",
      "Maintain a windbreak or hedge to reduce wind-driven rain and mechanical injury",
      "Do not work in orchards when the canopy is wet; avoid moving equipment through wet foliage",
      "Remove infected material promptly and dispose of it away from the production area",
    ],
    management: [
      "Have the diagnosis confirmed by a plant pathologist or extension officer; several conditions look similar",
      "Copper-containing bactericides are used in some regions under local label guidance; efficacy is local and label-specific",
      "Prune out and destroy infected tissue during dry conditions",
      "Control leafminer and any other insect that wounds young flush, reducing new infection sites",
      "Expect that heavily infected blocks may require a longer-term orchard renovation plan; seek professional advice",
    ],
    references: [
      "Local agricultural extension service publications for your region",
      "National plant quarantine and plant-protection department guidance",
    ],
  },

  greening: {
    slug: "greening",
    displayName: "Greening (Huanglongbing)",
    appliesTo: ["leaf", "fruit"],
    isHealthy: false,
    shortDescription:
      "A destructive disease associated with bacteria carried by psyllid insects. It disrupts the tree's phloem, so the canopy develops blotchy, asymmetric yellowing that is not confined by leaf veins, along with small, lopsided, poorly coloured fruit.",
    symptoms: [
      "Blotchy, irregular yellowing of leaves that crosses leaf veins (mottled rather than vein-defined)",
      "Yellowing that is asymmetric within the canopy, often on one branch",
      "Small, upright shoots with pale, narrow leaves",
      "Fruit that are small, lopsided, and remain green at the stem end when ripe",
      "Unbalanced or bitter-tasting fruit with aborted seeds",
      "Progressive twig dieback and canopy thinning over time",
    ],
    prevention: [
      "Use certified, pathogen-free nursery stock from a reputable source",
      "Control psyllid vectors with locally approved methods and monitor their population",
      "Remove infected trees promptly once confirmed, following local regulatory requirements",
      "Avoid moving plant material between regions; many jurisdictions restrict transport of citrus",
      "Maintain tree vigour with correct irrigation and nutrition, which does not cure infection but limits stress",
      "Keep new plantings at a density that allows inspection and vector management",
    ],
    management: [
      "There is no curative treatment for an infected tree; management focuses on prevention and vector control",
      "Confirm the diagnosis through an authoritative laboratory, as symptoms overlap with nutrient deficiencies",
      "Follow local reporting and quarantine rules, which commonly apply to this disease",
      "Plan psyllid control for the whole district rather than isolated blocks; vector control fails at single-tree scale",
      "Consult an extension specialist about replanting strategy and rootstock choice",
    ],
    references: [
      "Local agricultural extension service publications for your region",
      "National plant-protection department and citrus industry authority guidance",
    ],
  },

  melanose: {
    slug: "melanose",
    displayName: "Melanose",
    appliesTo: ["leaf"],
    isHealthy: false,
    shortDescription:
      "A fungal disease of citrus leaves and twigs. It produces small, raised, dark brown to black rough spots that give infected tissue a sandpaper-like feel. In this dataset the class is represented by leaf images only.",
    symptoms: [
      "Small, raised, dark brown to black spots on the leaf surface",
      "A distinctly rough, sandpaper-like texture when the leaf is rubbed",
      "Spots that may merge into irregular dark patches on older leaves",
      "Occasional twig lesions on young, susceptible flush",
      "Cosmetic damage on fruit in severe seasons, though leaf symptoms are the focus here",
    ],
    prevention: [
      "Prune dead and infected twigs, which carry the fungus between flushes",
      "Reduce leaf wetness by improving drainage and avoiding late-day overhead irrigation",
      "Keep the canopy open so humid pockets are less likely to develop",
      "Remove infected leaf litter from the orchard floor",
      "Avoid wounding the bark during cultural operations; wounds are infection courts",
    ],
    management: [
      "Confirm the diagnosis locally; melanose is frequently confused with other leaf spot diseases",
      "Where a registered fungicide is advised for your region, follow the label schedule and observe pre-harvest intervals",
      "Target the timing of protection to new flush, which is the most susceptible tissue",
      "Combine chemical and cultural measures; pruning without moisture management gives limited results",
    ],
    references: [
      "Local agricultural extension service publications for your region",
      "Citrus research institute disease fact sheets",
    ],
  },

  scab: {
    slug: "scab",
    displayName: "Scab",
    appliesTo: ["fruit"],
    isHealthy: false,
    shortDescription:
      "A fungal disease that mainly affects fruit. It forms wart-like, corky protrusions that break the rind surface and can distort young fruit, causing cosmetic damage and raising the risk of citrus canker entering through the lesions. In this dataset the class is represented by fruit images only.",
    symptoms: [
      "Small water-soaked spots that become raised, wart-like or corky",
      "Protrusions that may coalesce into rough, scabby areas on the rind",
      "Distortion and deformation of young, newly set fruit",
      "A corky, cracked surface that is cosmetically unacceptable for fresh market",
      "Scabs that can serve as entry points for other pathogens, including canker",
    ],
    prevention: [
      "Protect the fruit-setting period most rigorously, since fruit are most susceptible while very young",
      "Prune to open the canopy and improve airflow, reducing humidity around young fruit",
      "Remove infected fruit and fallen debris from the orchard floor",
      "Time irrigation to avoid prolonged leaf and fruit wetness",
      "Monitor the orchard through the fruit-set window, when targeted protection is most effective",
    ],
    management: [
      "Confirm the diagnosis with a local extension officer, as scab is often confused with canker or melanose",
      "Where a registered fungicide is recommended locally, focus applications on the fruit-set period",
      "Rotate labelled active ingredients and observe all label restrictions and pre-harvest intervals",
      "Reduce inoculum by removing mummified and fallen fruit before the next season",
    ],
    references: [
      "Local agricultural extension service publications for your region",
      "Citrus research institute disease fact sheets",
    ],
  },

  healthy: {
    slug: "healthy",
    displayName: "Healthy",
    appliesTo: ["leaf", "fruit"],
    isHealthy: true,
    shortDescription:
      "No visible symptoms of the diseases covered by this model were detected. A healthy result means this model found no evidence of its trained disease classes in the image; it is not a laboratory diagnosis and cannot rule out conditions outside the model\u2019s scope.",
    symptoms: [
      "Normal leaf colour and texture for the cultivar, without the lesions or mottling of the modelled diseases",
      "No raised corky spots, no dark circular lesions, no asymmetric yellowing",
      "Fruit surface free of the wart-like scab lesions and dark spots of the modelled diseases",
      "No visible dieback or premature defoliation attributable to a modelled disease",
    ],
    prevention: [
      "Continue routine orchard hygiene: remove dead tissue and fallen leaves, and keep the canopy open",
      "Monitor fruit and foliage through the season so early symptoms are noticed while still minor",
      "Keep irrigation consistent and avoid prolonged leaf wetness",
      "Use certified disease-free nursery stock for new plantings",
      "Inspect regularly, especially after wet weather, which favours several of these diseases",
    ],
    management: [
      "No disease treatment is indicated by this result",
      "Re-scan if symptoms develop or change, since a single image cannot represent a whole tree",
      "If the plant looks unwell overall, seek advice from a local agricultural expert, as causes outside this model\u2019s classes (nutrient deficiency, water stress, root problems, pests) are not assessed here",
    ],
    references: [
      "Local agricultural extension service publications for your region",
    ],
  },
};

export const HEALTHY_SLUG = "healthy";

/** Look up an entry by display name, slug, or any casing variant. */
export function getDiseaseEntry(key: string): DiseaseEntry | null {
  if (DISEASE_CONTENT[key]) return DISEASE_CONTENT[key];
  const normalized = key.trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (DISEASE_CONTENT[normalized]) return DISEASE_CONTENT[normalized];
  const byName = Object.values(DISEASE_CONTENT).find(
    (entry) => entry.displayName.toLowerCase() === key.trim().toLowerCase(),
  );
  return byName ?? null;
}

/**
 * Look up by any of the raw class names the model can emit
 * (`black spot`, `Black Spot`, `black_spot`, ...).
 */
export function getDiseaseEntryForClass(className: string, inputType?: "leaf" | "fruit" | null): DiseaseEntry | null {
  const direct = getDiseaseEntry(className);
  if (direct) {
    // Melanose is leaf-only and Scab is fruit-only; if the class does not apply
    // to the detected input type, do not present misleading information.
    if (inputType && direct.appliesTo.length > 0 && !direct.appliesTo.includes(inputType)) {
      return null;
    }
    return direct;
  }
  const normalized = className.trim().toLowerCase().replace(/[\s_]+/g, "-");
  const entry = DISEASE_CONTENT[normalized];
  if (entry && inputType && !entry.appliesTo.includes(inputType)) return null;
  return entry ?? null;
}

export const DISCLAIMER =
  "Guidance here is general agronomic information, not a diagnosis or a treatment prescription. Always confirm with a local agricultural expert or extension officer before applying any treatment, and follow local label requirements.";

export const XAI_DISCLAIMER =
  "The highlighted regions represent areas that contributed strongly to the model's prediction. This visualisation is an explanation aid, not a medical or agricultural diagnosis, and it does not prove that a disease is present.";
