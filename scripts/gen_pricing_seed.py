"""Generate the zone_zips / price_schedules seed SQL straight from Bid Table
BT-89AO, so the ZIP list is never retyped by hand. Appends to migration 0007."""
import openpyxl, re, sys

BID = r"C:/Users/mosch/OneDrive/Documents/Contracts/Pharmacy Courier Services (RFP-226-03-068-SVC)/Izy_Global_Bid_Table_082126_BAFO_FINAL_12.50.xlsx"
OUT = r"C:/Users/mosch/Downloads/Apps-Archive/tvhs-courier-logs/server/drizzle/0007_pricing.sql"
EFFECTIVE = "2026-05-18"  # BAFO submission date; rates firm from contract start

wb = openpyxl.load_workbook(BID, data_only=True)
rows = list(wb["Pricing"].iter_rows(values_only=True))

def zipish(v):
    return v is not None and re.fullmatch(r"\d{5}", str(v).strip()) is not None

# Column layout (verified against the sheet):
#   z1 zip=0 rate=1 | z2 zip=2 rate=3 | z3 zip=4 rate=5
#   z4 place=6 zip=7 rate=8 | z5 place=9 zip=10 rate=11
# Columns 3/4/5 are reused for the surcharge block once zone 2 runs out, so
# zone 3 ZIPs are only taken while the row still carries a zone-3 rate.
zones, rates, places = {}, {}, {}
for r in rows[1:]:
    def cell(i):
        return r[i] if i < len(r) else None
    for zone, (zc, rc, pc) in {1: (0, 1, None), 2: (2, 3, None), 3: (4, 5, None),
                               4: (7, 8, 6), 5: (10, 11, 9)}.items():
        z, rate = cell(zc), cell(rc)
        if zipish(z) and isinstance(rate, (int, float)):
            zones.setdefault(zone, []).append(str(z).strip())
            rates[zone] = float(rate)
            if pc is not None and cell(pc):
                places[str(z).strip()] = str(cell(pc)).strip()

# Surcharges live in the label/amount pair at columns 3/4 (5 for per-mile).
sur = {}
for r in rows:
    label = r[3] if len(r) > 3 else None
    if not isinstance(label, str):
        continue
    key = label.strip().lower()
    amount = r[4] if len(r) > 4 else None
    if key == "stat" and isinstance(amount, (int, float)):
        sur["stat"] = float(amount)
    elif key == "after hours" and isinstance(amount, (int, float)):
        sur["after_hours"] = float(amount)
    elif key.startswith("dry run") and isinstance(amount, (int, float)):
        sur["dry_run"] = float(amount)
    elif key.startswith("out of area"):
        per = r[5] if len(r) > 5 else None
        if isinstance(per, (int, float)):
            sur["per_mile"] = float(per)

all_zips = [z for v in zones.values() for z in v]
assert len(all_zips) == len(set(all_zips)), "a ZIP appears in more than one zone"
assert set(zones) == {1, 2, 3, 4, 5}, f"missing zones: {set(zones)}"
assert set(sur) == {"stat", "after_hours", "dry_run", "per_mile"}, f"missing surcharges: {set(sur)}"
for z in sorted(zones):
    print(f"zone {z}: rate {rates[z]:>6.2f}  zips {len(zones[z])}", file=sys.stderr)
print(f"surcharges: {sur}", file=sys.stderr)
print(f"total zips: {len(all_zips)}", file=sys.stderr)

lines = [
    "--> statement-breakpoint",
    "-- Zone ZIPs and the BAFO price schedule, generated from the Pricing sheet of",
    "-- Bid Table BT-89AO (see scratch gen_pricing_seed.py). Not hand-typed: a wrong",
    "-- ZIP here would misprice every delivery to it.",
    f"INSERT INTO `price_schedules` (`project_id`, `effective_from`, `label`, `zone1`, `zone2`, `zone3`, `zone4`, `zone5`, `stat_surcharge`, `after_hours_surcharge`, `dry_run_fee`, `out_of_area_per_mile`, `notes`)",
    f"SELECT p.`id`, '{EFFECTIVE}', 'Izy BAFO (RFP-226-03-068-SVC)', "
    f"{rates[1]:.2f}, {rates[2]:.2f}, {rates[3]:.2f}, {rates[4]:.2f}, {rates[5]:.2f}, "
    f"{sur['stat']:.2f}, {sur['after_hours']:.2f}, {sur['dry_run']:.2f}, {sur['per_mile']:.2f}, "
    "'Firm for the base term and both renewals; changes only by mutual written agreement (Addendum 1)'",
    "FROM `projects` p WHERE p.`code` = 'uh'",
    f"  AND NOT EXISTS (SELECT 1 FROM `price_schedules` s WHERE s.`project_id` = p.`id` AND s.`effective_from` = '{EFFECTIVE}');",
    "--> statement-breakpoint",
]

values = []
for zone in sorted(zones):
    for z in sorted(zones[zone]):
        place = places.get(z)
        place_sql = "NULL" if not place else "'" + place.replace("'", "''") + "'"
        values.append(f"SELECT '{z}' AS `zip`, {zone} AS `zone`, {place_sql} AS `place`")

lines.append("INSERT INTO `zone_zips` (`project_id`, `zip`, `zone`, `place`, `effective_from`)")
lines.append(f"SELECT p.`id`, v.`zip`, v.`zone`, v.`place`, '{EFFECTIVE}' FROM `projects` p, (")
lines.append("\n\tUNION ALL ".join("\t" + v if i == 0 else v for i, v in enumerate(values)))
lines.append(") v")
lines.append("WHERE p.`code` = 'uh' AND NOT EXISTS (")
lines.append(f"\tSELECT 1 FROM `zone_zips` z WHERE z.`project_id` = p.`id` AND z.`zip` = v.`zip` AND z.`effective_from` = '{EFFECTIVE}');")

with open(OUT, "a", encoding="utf-8") as fh:
    fh.write("\n".join(lines) + "\n")
print("appended to", OUT, file=sys.stderr)
