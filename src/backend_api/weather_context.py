
import os
from datetime import datetime
from urllib.parse import urlencode

OFFICIAL_WMS = "https://maps.effis.emergency.copernicus.eu/effis"
DOCUMENTATION = "https://forest-fire.emergency.copernicus.eu/downloads-instructions"


def weather_context():
    
    fields = {name: os.environ.get(name, "").strip() for name in (
        "SHARP_EFFIS_LAYER", "SHARP_EFFIS_ISSUE_TIME", "SHARP_EFFIS_VALID_TIME", "SHARP_EFFIS_RESOLUTION_KM")}
    if not all(fields.values()):
        return {"state": "unavailable", "provider": "Copernicus EFFIS", "documentation": DOCUMENTATION,
                "reason": "An official FWI layer and its issue, valid time and native resolution have not been configured."}
    for name in ("SHARP_EFFIS_ISSUE_TIME", "SHARP_EFFIS_VALID_TIME"):
        value = datetime.fromisoformat(fields[name].replace("Z", "+00:00"))
        if value.tzinfo is None:
            raise ValueError("EFFIS issue and valid times require UTC offsets.")
    resolution = float(fields["SHARP_EFFIS_RESOLUTION_KM"])
    if resolution <= 0:
        raise ValueError("EFFIS native resolution must be positive.")
    parameters = {"SERVICE": "WMS", "VERSION": "1.1.1", "REQUEST": "GetMap", "LAYERS": fields["SHARP_EFFIS_LAYER"],
                  "STYLES": "", "FORMAT": "image/png", "TRANSPARENT": "true", "SRS": "EPSG:3857", "WIDTH": "256", "HEIGHT": "256",
                  "TIME": fields["SHARP_EFFIS_VALID_TIME"]}
    return {"state": "configured", "provider": "Copernicus EFFIS", "metric": "Fire Weather Index", "unit": "Native FWI index",
            "issueTime": fields["SHARP_EFFIS_ISSUE_TIME"], "validTime": fields["SHARP_EFFIS_VALID_TIME"],
            "resolutionKm": resolution, "documentation": DOCUMENTATION,
            "tileUrl": OFFICIAL_WMS + "?" + urlencode(parameters) + "&BBOX={bbox-epsg-3857}",
            "interpretation": "Provider fire-danger context, distinct from a SHARP reported-hotspot probability."}
