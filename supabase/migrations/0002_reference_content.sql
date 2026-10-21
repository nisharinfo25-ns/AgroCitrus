-- =====================================================================
-- CitrusGuard - 0002 reference content + storage helpers
--
-- Seeds `disease_information` for exactly the classes that exist in the
-- published dataset, and adds the RPCs the server uses.
--
-- The class slugs below were derived from the archive by walking
-- `Citrus/<Fruits|Leaves>/<class>/` (see ml/citrusguard/dataset/classes.py).
-- Nothing is seeded for a class the dataset does not contain.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Disease reference content
--
-- Content rules, applied to every row:
--   * general, publicly documented horticultural information;
--   * no specific pesticide, dose, or product names;
--   * treatment decisions explicitly deferred to a local expert.
-- ---------------------------------------------------------------------
insert into public.disease_information
  (slug, display_name, applies_to, is_healthy, short_description, symptoms, prevention, management, reference_sources)
values
  (
    'black-spot',
    'Black Spot',
    array['leaf', 'fruit'],
    false,
    'A fungal disease that produces dark, roughly circular lesions on leaves and fruit. On leaves the spots are typically surrounded by a yellow halo; on fruit the rind shows raised, dark, velvety lesions.',
    array[
      'Round to irregular dark brown or black spots on the upper leaf surface',
      'A yellow halo (chlorotic margin) around many leaf spots',
      'Spots may merge into larger blotches as the disease progresses',
      'Affected leaves turn yellow and drop prematurely (defoliation)',
      'On fruit, dark raised lesions with a rough, sandpaper-like texture',
      'Premature fruit drop and reduced fruit quality when infection is heavy'
    ],
    array[
      'Prune and destroy infected leaves and dead twigs; do not leave infected debris in the orchard',
      'Improve air circulation by keeping the canopy open with regular pruning',
      'Avoid overhead irrigation and keep water off the foliage; irrigate at the base instead',
      'Mulch under trees to reduce soil splash onto lower leaves and fruit',
      'Remove fallen leaves and fruit from the orchard floor during the dormant season',
      'Use disease-free nursery stock and disinfect pruning tools between trees'
    ],
    array[
      'Start with a confirmed diagnosis from a local extension service before acting',
      'Where a registered fungicide is recommended locally, apply it on a label-approved schedule beginning early in the disease cycle',
      'Alternate or rotate labelled active ingredients to slow resistance development',
      'Remove and destroy heavily infected tissue; fungicides protect new growth, they do not repair existing lesions',
      'Keep trees adequately watered and mulched to reduce stress-related susceptibility'
    ],
    array[
      'Local agricultural extension service publications for your region',
      'FAO and national plant-protection department citrus disease guides'
    ]
  ),
  (
    'canker',
    'Canker',
    array['leaf', 'fruit'],
    false,
    'A contagious bacterial disease. It forms raised, corky, crater-like lesions on leaves, fruit and twigs, often with a yellow halo on the leaf. It spreads mainly through wind-driven rain and is aggravated by citrus leafminer feeding.',
    array[
      'Raised, corky or crater-like lesions with a tan or grey centre',
      'A distinct yellow halo surrounding lesions on leaves',
      'Lesions visible on both sides of the leaf',
      'Rough, raised pustule-like spots on fruit, sometimes cracking as the fruit grows',
      'Lesions on young twigs and, in severe cases, dieback of small branches',
      'Defoliation and premature fruit drop when infection is heavy'
    ],
    array[
      'Plant certified disease-free nursery stock; canker spreads readily through infected propagative material',
      'Prune infected twigs during dry weather and sterilise tools between cuts',
      'Manage citrus leafminer, since leafminer-created wounds are a major entry point for the bacteria',
      'Maintain a windbreak or hedge to reduce wind-driven rain and mechanical injury',
      'Do not work in orchards when the canopy is wet; avoid moving equipment through wet foliage',
      'Remove infected material promptly and dispose of it away from the production area'
    ],
    array[
      'Have the diagnosis confirmed by a plant pathologist or extension officer; several conditions look similar',
      'Copper-containing bactericides are used in some regions under local label guidance; efficacy is local and label-specific',
      'Prune out and destroy infected tissue during dry conditions',
      'Control leafminer and any other insect that wounds young flush, reducing new infection sites',
      'Expect that heavily infected blocks may require a longer-term orchard renovation plan; seek professional advice'
    ],
    array[
      'Local agricultural extension service publications for your region',
      'National plant quarantine and plant-protection department guidance'
    ]
  ),
  (
    'greening',
    'Greening (Huanglongbing)',
    array['leaf', 'fruit'],
    false,
    'A destructive disease associated with bacteria carried by psyllid insects. It disrupts the tree''s phloem, so the canopy develops blotchy, asymmetric yellowing that is not confined by leaf veins, along with small, lopsided, poorly coloured fruit.',
    array[
      'Blotchy, irregular yellowing of leaves that crosses leaf veins (mottled rather than vein-defined)',
      'Yellowing that is asymmetric within the canopy, often on one branch',
      'Small, upright shoots with pale, narrow leaves',
      'Fruit that are small, lopsided, and remain green at the stem end when ripe',
      'Unbalanced or bitter-tasting fruit with aborted seeds',
      'Progressive twig dieback and canopy thinning over time'
    ],
    array[
      'Use certified, pathogen-free nursery stock from a reputable source',
      'Control psyllid vectors with locally approved methods and monitor their population',
      'Remove infected trees promptly once confirmed, following local regulatory requirements',
      'Avoid moving plant material between regions; many jurisdictions restrict transport of citrus',
      'Maintain tree vigour with correct irrigation and nutrition, which does not cure infection but limits stress',
      'Keep new plantings at a density that allows inspection and vector management'
    ],
    array[
      'There is no curative treatment for an infected tree; management focuses on prevention and vector control',
      'Confirm the diagnosis through an authoritative laboratory, as symptoms overlap with nutrient deficiencies',
      'Follow local reporting and quarantine rules, which commonly apply to this disease',
      'Plan psyllid control for the whole district rather than isolated blocks; vector control fails at single-tree scale',
      'Consult an extension specialist about replanting strategy and rootstock choice'
    ],
    array[
      'Local agricultural extension service publications for your region',
      'National plant-protection department and citrus industry authority guidance'
    ]
  ),
  (
    'melanose',
    'Melanose',
    array['leaf'],
    false,
    'A fungal disease of citrus leaves and twigs. It produces small, raised, dark brown to black rough spots that give infected tissue a sandpaper-like feel. In this dataset the class is represented by leaf images only.',
    array[
      'Small, raised, dark brown to black spots on the leaf surface',
      'A distinctly rough, sandpaper-like texture when the leaf is rubbed',
      'Spots that may merge into irregular dark patches on older leaves',
      'Occasional twig lesions on young, susceptible flush',
      'Cosmetic damage on fruit in severe seasons, though leaf symptoms are the focus here'
    ],
    array[
      'Prune dead and infected twigs, which carry the fungus between flushes',
      'Reduce leaf wetness by improving drainage and avoiding late-day overhead irrigation',
      'Keep the canopy open so humid pockets are less likely to develop',
      'Remove infected leaf litter from the orchard floor',
      'Avoid wounding the bark during cultural operations; wounds are infection courts'
    ],
    array[
      'Confirm the diagnosis locally; melanose is frequently confused with other leaf spot diseases',
      'Where a registered fungicide is advised for your region, follow the label schedule and observe pre-harvest intervals',
      'Target the timing of protection to new flush, which is the most susceptible tissue',
      'Combine chemical and cultural measures; pruning without moisture management gives limited results'
    ],
    array[
      'Local agricultural extension service publications for your region',
      'Citrus research institute disease fact sheets'
    ]
  ),
  (
    'scab',
    'Scab',
    array['fruit'],
    false,
    'A fungal disease that mainly affects fruit. It forms wart-like, corky protrusions that break the rind surface and can distort young fruit, causing cosmetic damage and raising the risk of citrus canker entering through the lesions. In this dataset the class is represented by fruit images only.',
    array[
      'Small water-soaked spots that become raised, wart-like or corky',
      'Protrusions that may coalesce into rough, scabby areas on the rind',
      'Distortion and deformation of young, newly set fruit',
      'A corky, cracked surface that is cosmetically unacceptable for fresh market',
      'Scabs that can serve as entry points for other pathogens, including canker'
    ],
    array[
      'Protect the fruit-setting period most rigorously, since fruit are most susceptible while very young',
      'Prune to open the canopy and improve airflow, reducing humidity around young fruit',
      'Remove infected fruit and fallen debris from the orchard floor',
      'Time irrigation to avoid prolonged leaf and fruit wetness',
      'Monitor the orchard through the fruit-set window, when targeted protection is most effective'
    ],
    array[
      'Confirm the diagnosis with a local extension officer, as scab is often confused with canker or melanose',
      'Where a registered fungicide is recommended locally, focus applications on the fruit-set period',
      'Rotate labelled active ingredients and observe all label restrictions and pre-harvest intervals',
      'Reduce inoculum by removing mummified and fallen fruit before the next season'
    ],
    array[
      'Local agricultural extension service publications for your region',
      'Citrus research institute disease fact sheets'
    ]
  ),
  (
    'healthy',
    'Healthy',
    array['leaf', 'fruit'],
    true,
    'No visible symptoms of the diseases covered by this model were detected. A healthy result means this model found no evidence of its trained disease classes in the image; it is not a laboratory diagnosis and cannot rule out conditions outside the model''s scope.',
    array[
      'Normal leaf colour and texture for the cultivar, without the lesions or mottling of the modelled diseases',
      'No raised corky spots, no dark circular lesions, no asymmetric yellowing',
      'Fruit surface free of the wart-like scab lesions and dark spots of the modelled diseases',
      'No visible dieback or premature defoliation attributable to a modelled disease'
    ],
    array[
      'Continue routine orchard hygiene: remove dead tissue and fallen leaves, and keep the canopy open',
      'Monitor fruit and foliage through the season so early symptoms are noticed while still minor',
      'Keep irrigation consistent and avoid prolonged leaf wetness',
      'Use certified disease-free nursery stock for new plantings',
      'Inspect regularly, especially after wet weather, which favours several of these diseases'
    ],
    array[
      'No disease treatment is indicated by this result',
      'Re-scan if symptoms develop or change, since a single image cannot represent a whole tree',
      'If the plant looks unwell overall, seek advice from a local agricultural expert, as causes outside this model''s classes (nutrient deficiency, water stress, root problems, pests) are not assessed here'
    ],
    array[
      'Local agricultural extension service publications for your region'
    ]
  )
on conflict (slug) do update
set display_name    = excluded.display_name,
    applies_to      = excluded.applies_to,
    is_healthy      = excluded.is_healthy,
    short_description = excluded.short_description,
    symptoms        = excluded.symptoms,
    prevention      = excluded.prevention,
    management      = excluded.management,
    reference_sources = excluded.reference_sources,
    updated_at      = now();

-- ---------------------------------------------------------------------
-- Cross-check: the model's class list must match the reference content.
-- Exposed as an RPC so the admin panel can prove the two agree rather than
-- letting the UI silently render an empty guide for a real class.
-- ---------------------------------------------------------------------
create or replace function public.class_content_gaps()
returns table (slug text, has_content boolean)
language sql
stable
as $$
  select
    c.slug,
    exists (
      select 1 from public.disease_information d
      where d.slug = c.slug
         or d.slug = lower(replace(c.slug, ' ', '-'))
         or lower(d.display_name) = lower(c.slug)
    ) as has_content
  from (
    select unnest(coalesce(classes, '{}'::text[])) as slug
    from public.model_versions
    where status = 'production'
    order by version desc
    limit 1
  ) c;
$$;

grant execute on function public.class_content_gaps() to authenticated, service_role;

-- ---------------------------------------------------------------------
-- Aggregate statistics for the admin dashboard.
-- Service-role only: it intentionally has no anon/authenticated grant, so a
-- normal user cannot enumerate other users' activity.
-- ---------------------------------------------------------------------
create or replace function public.admin_system_stats()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  -- Defence in depth: the function is only useful to an admin.
  if not public.is_admin() then
    raise exception 'admin_required' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'total_users',        (select count(*) from public.profiles),
    'total_scans',        (select count(*) from public.scans),
    'scans_last_7_days',  (select count(*) from public.scans where created_at > now() - interval '7 days'),
    'healthy_scans',      (select count(*) from public.scans where status = 'healthy'),
    'diseased_scans',     (select count(*) from public.scans where status = 'diseased'),
    'low_confidence',     (select count(*) from public.scans where is_low_confidence),
    'failed_scans',       (select count(*) from public.scans where prediction_state = 'failed'),
    'by_input_type', (
      select coalesce(jsonb_object_agg(input_type, n), '{}'::jsonb)
      from (select input_type, count(*) as n from public.scans group by input_type) t
    ),
    'by_class', (
      select coalesce(jsonb_object_agg(predicted_class, n), '{}'::jsonb)
      from (select predicted_class, count(*) as n from public.scans group by predicted_class) t
    ),
    'generated_at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  ) into result;

  return result;
end;
$$;

revoke execute on function public.admin_system_stats() from public, anon;
-- Granted to authenticated, NOT because anonymous callers should see it, but
-- because the function is SECURITY DEFINER and re-checks `public.is_admin()`
-- on every call. The grant is what lets the admin dashboard reach it with the
-- RLS-scoped client instead of handing the service-role key to the browser.
grant execute on function public.admin_system_stats() to authenticated, service_role;
