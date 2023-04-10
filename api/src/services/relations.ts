import type { Knex } from 'knex';
import { systemRelationRows } from '../database/system-data/relations/index.js';
import { ForbiddenException, InvalidPayloadException } from '../exceptions/index.js';
import type { SchemaOverview, Relation, RelationMeta, Accountability, Query } from '@directus/shared/types';
import { toArray } from '@directus/shared/utils';
import { ItemsService, QueryOptions } from './items.js';
import { PermissionsService } from './permissions.js';
import SchemaInspector from '@directus/schema';
import getDatabase, { getSchemaInspector } from '../database/index.js';
import { getDefaultIndexName } from '../utils/get-default-index-name.js';
import { getCache } from '../cache.js';
import type { AbstractServiceOptions } from '../types/index.js';
import { getHelpers, Helpers } from '../database/helpers/index.js';
import type { CacheService } from './cache/cache.js';
import { stitchRelations } from '../utils/stitch-relations.js';
import { clearRelationsForField } from '../utils/clearSystemCache.js';

export class RelationsService {
	knex: Knex;
	permissionsService: PermissionsService;
	schemaInspector: ReturnType<typeof SchemaInspector>;
	accountability: Accountability | null;
	schema: SchemaOverview;
	relationsItemService: ItemsService<RelationMeta>;
	systemCache: CacheService;
	helpers: Helpers;

	constructor(options: AbstractServiceOptions) {
		this.knex = options.knex || getDatabase();
		this.permissionsService = new PermissionsService(options);
		this.schemaInspector = options.knex ? SchemaInspector(options.knex) : getSchemaInspector();
		this.schema = options.schema;
		this.accountability = options.accountability || null;
		this.relationsItemService = new ItemsService('directus_relations', {
			knex: this.knex,
			schema: this.schema,
			// We don't set accountability here. If you have read access to certain fields, you are
			// allowed to extract the relations regardless of permissions to directus_relations. This
			// happens in `filterForbidden` down below
		});

		this.systemCache = getCache().systemCache;
		this.helpers = getHelpers(this.knex);
	}

	async readAll(collection?: string, opts?: QueryOptions): Promise<Relation[]> {
		if (this.accountability && this.accountability.admin !== true && this.hasReadAccess === false) {
			throw new ForbiddenException();
		}

		const metaReadQuery: Query = {
			limit: -1,
		};

		if (collection) {
			metaReadQuery.filter = {
				many_collection: {
					_eq: collection,
				},
			};
		}

		const metaRows = [
			...(await this.relationsItemService.readByQuery(metaReadQuery, opts)),
			...systemRelationRows,
		].filter((metaRow) => {
			if (!collection) return true;
			return metaRow.many_collection === collection;
		});

		const schemaRows = await this.schemaInspector.foreignKeys(collection);
		const results = stitchRelations(metaRows, schemaRows);
		return await this.filterForbidden(results);
	}

	async readOne(collection: string, field: string): Promise<Relation> {
		if (this.accountability && this.accountability.admin !== true) {
			if (this.hasReadAccess === false) {
				throw new ForbiddenException();
			}

			const permissions = this.accountability.permissions?.find((permission) => {
				return permission.action === 'read' && permission.collection === collection;
			});

			if (!permissions || !permissions.fields) throw new ForbiddenException();
			if (permissions.fields.includes('*') === false) {
				const allowedFields = permissions.fields;
				if (allowedFields.includes(field) === false) throw new ForbiddenException();
			}
		}

		const metaRow = await this.relationsItemService.readByQuery({
			limit: 1,
			filter: {
				_and: [
					{
						many_collection: {
							_eq: collection,
						},
					},
					{
						many_field: {
							_eq: field,
						},
					},
				],
			},
		});

		const schemaRow = (await this.schemaInspector.foreignKeys(collection)).find(
			(foreignKey: any) => foreignKey.column === field
		);
		const stitched = stitchRelations(metaRow, schemaRow ? [schemaRow] : []);
		const results = await this.filterForbidden(stitched);

		if (results.length === 0) {
			throw new ForbiddenException();
		}

		return results[0]!;
	}

	/**
	 * Create a new relationship / foreign key constraint
	 */
	async createOne(relation: Partial<Relation>): Promise<void> {
		if (this.accountability && this.accountability.admin !== true) {
			throw new ForbiddenException();
		}

		if (!relation.collection) {
			throw new InvalidPayloadException('"collection" is required');
		}

		if (!relation.field) {
			throw new InvalidPayloadException('"field" is required');
		}

		const collections = await this.schema.getCollections()

		if (relation.collection in collections === false) {
			throw new InvalidPayloadException(`Collection "${relation.collection}" doesn't exist`);
		}

		const fields = await this.schema.getFields(relation.collection)

		if (relation.field in fields === false) {
			throw new InvalidPayloadException(
				`Field "${relation.field}" doesn't exist in collection "${relation.collection}"`
			);
		}

		// A primary key should not be a foreign key
		if (collections[relation.collection]!.primary === relation.field) {
			throw new InvalidPayloadException(
				`Field "${relation.field}" in collection "${relation.collection}" is a primary key`
			);
		}

		if (relation.related_collection && relation.related_collection in collections === false) {
			throw new InvalidPayloadException(`Collection "${relation.related_collection}" doesn't exist`);
		}

		const existingRelation = Object.values(await this.schema.getRelationsForCollection(relation.collection)).find(
			(existingRelation) => existingRelation.field === relation.field );

		if (existingRelation) {
			throw new InvalidPayloadException(
				`Field "${relation.field}" in collection "${relation.collection}" already has an associated relationship`
			);
		}

		const runPostColumnChange = await this.helpers.schema.preColumnChange();

		try {
			const metaRow = {
				...(relation.meta || {}),
				many_collection: relation.collection,
				many_field: relation.field,
				one_collection: relation.related_collection || null,
			};

			await this.knex.transaction(async (trx) => {
				if (relation.related_collection) {
					await trx.schema.alterTable(relation.collection!, async (table) => {
						await this.alterType(table, relation);

						const constraintName: string = getDefaultIndexName('foreign', relation.collection!, relation.field!);
						const builder = table
							.foreign(relation.field!, constraintName)
							.references(
								`${relation.related_collection!}.${collections[relation.related_collection!]!.primary}`
							);

						if (relation.schema?.on_delete) {
							builder.onDelete(relation.schema.on_delete);
						}
					});
				}

				const relationsItemService = new ItemsService('directus_relations', {
					knex: trx,
					schema: this.schema,
					// We don't set accountability here. If you have read access to certain fields, you are
					// allowed to extract the relations regardless of permissions to directus_relations. This
					// happens in `filterForbidden` down below
				});

				await relationsItemService.createOne(metaRow);
			});
		} finally {
			if (runPostColumnChange) {
				await this.helpers.schema.postColumnChange();
			}

			await this.systemCache.setHashFull(`relations:${relation.collection}`, false);
		}
	}

	/**
	 * Update an existing foreign key constraint
	 *
	 * Note: You can update anything under meta, but only the `on_delete` trigger under schema
	 */
	async updateOne(collection: string, field: string, relation: Partial<Relation>): Promise<void> {
		if (this.accountability && this.accountability.admin !== true) {
			throw new ForbiddenException();
		}

		if (!await this.schema.hasCollection(collection)) {
			throw new InvalidPayloadException(`Collection "${collection}" doesn't exist`);
		}

		if (!await this.schema.hasField(collection, field)) {
			throw new InvalidPayloadException(`Field "${field}" doesn't exist in collection "${collection}"`);
		}

		const existingRelation = await this.schema.getRelationsForField(collection, field)

		if (!existingRelation) {
			throw new InvalidPayloadException(`Field "${field}" in collection "${collection}" doesn't have a relationship.`);
		}

		const runPostColumnChange = await this.helpers.schema.preColumnChange();

		try {
			await this.knex.transaction(async (trx) => {
				if (existingRelation.related_collection) {
					await trx.schema.alterTable(collection, async (table) => {
						let constraintName: string = getDefaultIndexName('foreign', collection, field);

						// If the FK already exists in the DB, drop it first
						if (existingRelation?.schema) {
							constraintName = existingRelation.schema.constraint_name || constraintName;
							table.dropForeign(field, constraintName);
						}

						await this.alterType(table, relation);

						const builder = table
							.foreign(field, constraintName || undefined)
							.references(
								`${existingRelation.related_collection!}.${
									(await this.schema.getCollection(existingRelation.related_collection!))!.primary
								}`
							);

						if (relation.schema?.on_delete) {
							builder.onDelete(relation.schema.on_delete);
						}
					});
				}

				const relationsItemService = new ItemsService('directus_relations', {
					knex: trx,
					schema: this.schema,
					// We don't set accountability here. If you have read access to certain fields, you are
					// allowed to extract the relations regardless of permissions to directus_relations. This
					// happens in `filterForbidden` down below
				});

				if (relation.meta) {
					if (existingRelation?.meta) {
						await relationsItemService.updateOne(existingRelation.meta.id, relation.meta);
					} else {
						await relationsItemService.createOne({
							...(relation.meta || {}),
							many_collection: relation.collection,
							many_field: relation.field,
							one_collection: existingRelation.related_collection || null,
						});
					}
				}
			});
		} finally {
			if (runPostColumnChange) {
				await this.helpers.schema.postColumnChange();
			}

			await clearRelationsForField(collection, field);
		}
	}

	/**
	 * Delete an existing relationship
	 */
	async deleteOne(collection: string, field: string): Promise<void> {
		if (this.accountability && this.accountability.admin !== true) {
			throw new ForbiddenException();
		}

		if (!await this.schema.hasCollection(collection)) {
			throw new InvalidPayloadException(`Collection "${collection}" doesn't exist`);
		}

		if (!await this.schema.hasField(collection, field)) {
			throw new InvalidPayloadException(`Field "${field}" doesn't exist in collection "${collection}"`);
		}

		const existingRelation = await this.schema.getRelationsForField(collection, field);

		if (!existingRelation) {
			throw new InvalidPayloadException(`Field "${field}" in collection "${collection}" doesn't have a relationship.`);
		}

		const runPostColumnChange = await this.helpers.schema.preColumnChange();

		try {
			await this.knex.transaction(async (trx) => {
				const existingConstraints = await this.schemaInspector.foreignKeys();
				const constraintNames = existingConstraints.map((key: any) => key.constraint_name);

				if (
					existingRelation.schema?.constraint_name &&
					constraintNames.includes(existingRelation.schema.constraint_name)
				) {
					await trx.schema.alterTable(existingRelation.collection, (table) => {
						table.dropForeign(existingRelation.field, existingRelation.schema!.constraint_name!);
					});
				}

				if (existingRelation.meta) {
					await trx('directus_relations').delete().where({ many_collection: collection, many_field: field });
				}
			});
		} finally {
			if (runPostColumnChange) {
				await this.helpers.schema.postColumnChange();
			}

			await clearRelationsForField(collection, field);
		}
	}

	/**
	 * Whether or not the current user has read access to relations
	 */
	private get hasReadAccess() {
		return !!this.accountability?.permissions?.find((permission) => {
			return permission.collection === 'directus_relations' && permission.action === 'read';
		});
	}

	/**
	 * Loop over all relations and filter out the ones that contain collections/fields you don't have
	 * permissions to
	 */
	private async filterForbidden(relations: Relation[]): Promise<Relation[]> {
		if (this.accountability === null || this.accountability?.admin === true) return relations;

		const allowedCollections =
			this.accountability.permissions
				?.filter((permission) => {
					return permission.action === 'read';
				})
				.map(({ collection }) => collection) ?? [];

		const allowedFields = this.permissionsService.getAllowedFields('read');

		relations = toArray(relations);

		return relations.filter((relation) => {
			let collectionsAllowed = true;
			let fieldsAllowed = true;

			if (allowedCollections.includes(relation.collection) === false) {
				collectionsAllowed = false;
			}

			if (relation.related_collection && allowedCollections.includes(relation.related_collection) === false) {
				collectionsAllowed = false;
			}

			if (
				relation.meta?.one_allowed_collections &&
				relation.meta?.one_allowed_collections.every((collection) => allowedCollections.includes(collection)) === false
			) {
				collectionsAllowed = false;
			}

			if (
				!allowedFields[relation.collection] ||
				(allowedFields[relation.collection]!.includes('*') === false &&
					allowedFields[relation.collection]!.includes(relation.field) === false)
			) {
				fieldsAllowed = false;
			}

			if (
				relation.related_collection &&
				relation.meta?.one_field &&
				(!allowedFields[relation.related_collection] ||
					(allowedFields[relation.related_collection]!.includes('*') === false &&
						allowedFields[relation.related_collection]!.includes(relation.meta.one_field) === false))
			) {
				fieldsAllowed = false;
			}

			return collectionsAllowed && fieldsAllowed;
		});
	}

	/**
	 * MySQL Specific
	 *
	 * MySQL doesn't accept FKs from `int` to `int unsigned`. `knex` defaults `.increments()` to
	 * `unsigned`, but defaults regular `int` to `int`. This means that created m2o fields have the
	 * wrong type. This step will force the m2o `int` field into `unsigned`, but only if both types are
	 * integers, and only if we go from `int` to `int unsigned`.
	 *
	 * @TODO This is a bit of a hack, and might be better of abstracted elsewhere
	 */
	private async alterType(table: Knex.TableBuilder, relation: Partial<Relation>) {
		
		const m2oFieldDBType = (await this.schema.getField(relation.collection!, relation.field!))!.dbType;

		const relatedFieldDBType = (await this.schema.getPrimaryKeyField(relation.related_collection!))!.dbType;

		if (m2oFieldDBType !== relatedFieldDBType && m2oFieldDBType === 'int' && relatedFieldDBType === 'int unsigned') {
			table.specificType(relation.field!, 'int unsigned').alter();
		}
	}
}
