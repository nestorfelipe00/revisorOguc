-- Ciudad 3D: las comunas completas se publican como teselas .json.gz (tools/gis/teselas_ciudad.py); la web las
-- descomprime en el navegador. El bucket acepta también application/gzip.
update storage.buckets
set allowed_mime_types = array['application/json', 'application/gzip']
where id = 'ciudad';
