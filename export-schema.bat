mongodump -d dev -c _SCHEMA -o schema
bsondump --pretty schema/dev/_SCHEMA.bson > schema/schema.json
