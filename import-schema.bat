mongo --eval "db.getCollection('_SCHEMA').drop()" dev
mongorestore schema/
