/*
	esperanto.js v0.6.3 - 2015-01-19
	http://esperantojs.org

	Released under the MIT License.
*/

(function (global, factory) {
	typeof exports === 'object' && typeof module !== 'undefined' ? module.exports = factory(require('acorn'), require('magic-string'), require('estraverse')) :
	typeof define === 'function' && define.amd ? define(['acorn', 'magic-string', 'estraverse'], factory) :
	global.esperanto = factory(global.acorn, global.MagicString, global.estraverse)
}(this, function (acorn, MagicString, estraverse) { 'use strict';

	var hasOwnProp = Object.prototype.hasOwnProperty;

	function hasNamedImports ( mod ) {
		var i = mod.imports.length;

		while ( i-- ) {
			if ( mod.imports[i].isNamed ) {
				return true;
			}
		}
	}

	function hasNamedExports ( mod ) {
		var i = mod.exports.length;

		while ( i-- ) {
			if ( !mod.exports[i].isDefault ) {
				return true;
			}
		}
	}

	/*
		This module traverse a module's AST, attaching scope information
		to nodes as it goes, which is later used to determine which
		identifiers need to be rewritten to avoid collisions
	*/

	var Scope = function ( options ) {
		options = options || {};

		this.parent = options.parent;
		this.names = options.params || [];
	};

	Scope.prototype = {
		add: function ( name ) {
			this.names.push( name );
		},

		contains: function ( name, ignoreTopLevel ) {
			if ( ignoreTopLevel && !this.parent ) {
				return false;
			}

			if ( ~this.names.indexOf( name ) ) {
				return true;
			}

			if ( this.parent ) {
				return this.parent.contains( name, ignoreTopLevel );
			}

			return false;
		}
	};

	function annotateAst ( ast ) {
		var scope = new Scope(), blockScope = new Scope(), declared = {}, topLevelFunctionNames = [], templateLiteralRanges = [];

		var envDepth = 0;

		estraverse.traverse( ast, {
			enter: function ( node ) {
				if ( node.type === 'ImportDeclaration' ) {
					node._skip = true;
				}

				if ( node._skip ) {
					return this.skip();
				}

				switch ( node.type ) {
					case 'FunctionExpression':
					case 'FunctionDeclaration':

						envDepth++;

						// fallthrough

					case 'ArrowFunctionExpression':
						if ( node.id ) {
							addToScope( node );

							// If this is the root scope, this may need to be
							// exported early, so we make a note of it
							if ( !scope.parent ) {
								topLevelFunctionNames.push( node.id.name );
							}
						}

						scope = node._scope = new Scope({
							parent: scope,
							params: node.params.map( function(x ) {return x.name} ) // TODO rest params?
						});

						break;

					case 'BlockStatement':
						blockScope = node._blockScope = new Scope({
							parent: blockScope
						});

						break;

					case 'VariableDeclaration':
						node.declarations.forEach( node.kind === 'let' ? addToBlockScope : addToScope );
						break;

					case 'ClassExpression':
					case 'ClassDeclaration':
						addToScope( node );
						break;

					case 'MemberExpression':
						if ( envDepth === 0 && node.object.type === 'ThisExpression' ) {
							throw new Error('`this` at the top level is undefined');
						}
						!node.computed && ( node.property._skip = true );
						break;

					case 'Property':
						node.key._skip = true;
						break;

					case 'TemplateLiteral':
						templateLiteralRanges.push([ node.start, node.end ]);
						break;

					case 'ThisExpression':
						if (envDepth === 0) {
							node._topLevel = true;
						}
						break;
				}
			},
			leave: function ( node ) {
				switch ( node.type ) {
					case 'FunctionExpression':
					case 'FunctionDeclaration':

						envDepth--;

						// fallthrough

					case 'ArrowFunctionExpression':

						scope = scope.parent;

						break;

					case 'BlockStatement':
						blockScope = blockScope.parent;
						break;
				}
			}
		});

		function addToScope ( declarator ) {
			var name = declarator.id.name;

			scope.add( name );
			declared[ name ] = true;
		}

		function addToBlockScope ( declarator ) {
			var name = declarator.id.name;

			blockScope.add( name );
			declared[ name ] = true;
		}

		ast._scope = scope;
		ast._blockScope = blockScope;
		ast._topLevelNames = ast._scope.names.concat( ast._blockScope.names );
		ast._topLevelFunctionNames = topLevelFunctionNames;
		ast._declared = declared;
		ast._templateLiteralRanges = templateLiteralRanges;
	}

	/**
	 * Inspects a module and discovers/categorises import & export declarations
	 * @param {object} mod - the module object
	 * @param {string} source - the module's original source code
	 * @param {object} ast - the result of parsing `source` with acorn
	 * @returns {array} - [ imports, exports ]
	 */
	function findImportsAndExports ( mod, source, ast ) {
		var imports = [], exports = [], previousDeclaration;

		ast.body.forEach( function(node ) {
			var passthrough, declaration;

			if ( previousDeclaration ) {
				previousDeclaration.next = node.start;

				if ( node.type !== 'EmptyStatement' ) {
					previousDeclaration = null;
				}
			}

			if ( node.type === 'ImportDeclaration' ) {
				declaration = processImport( node );
				imports.push( declaration );
			}

			else if ( node.type === 'ExportDeclaration' ) {
				declaration = processExport( node, source );
				exports.push( declaration );

				if ( declaration.isDefault ) {
					if ( mod.defaultExport ) {
						throw new Error( 'Duplicate default exports' );
					}
					mod.defaultExport = declaration;
				}

				if ( node.source ) {
					// it's both an import and an export, e.g.
					// `export { foo } from './bar';
					passthrough = processImport( node, true );
					imports.push( passthrough );

					declaration.passthrough = passthrough;
				}
			}

			if ( declaration ) {
				previousDeclaration = declaration;
			}
		});

		// catch any trailing semicolons
		if ( previousDeclaration ) {
			previousDeclaration.next = source.length;
			previousDeclaration.isFinal = true;
		}

		return [ imports, exports ];
	}

	/**
	 * Generates a representation of an import declaration
	 * @param {object} node - the original AST node
	 * @param {boolean} passthrough - `true` if this is an `export { foo } from 'bar'`-style declaration
	 * @returns {object}
	 */
	function processImport ( node, passthrough ) {
		var x = {
			id: null, // used by bundler - filled in later
			node: node,
			start: node.start,
			end: node.end,
			passthrough: !!passthrough,

			path: node.source.value,
			specifiers: node.specifiers.map( function(s ) {
				var id;

				if ( s.type === 'ImportBatchSpecifier' ) {
					return {
						isBatch: true,
						name: s.name.name,
						as: s.name.name
					};
				}

				id = s.id.name;

				return {
					isDefault: !!s.default,
					name: s.default ? 'default' : id,
					as: s.name ? s.name.name : id
				};
			})
		};

		// TODO have different types of imports - batch, default, named
		if ( x.specifiers.length === 0 ) {
			x.isEmpty = true;
		} else if ( x.specifiers.length === 1 ) {
			if ( x.specifiers[0].isDefault ) {
				x.isDefault = true;
				x.name = x.specifiers[0].as;
			}

			if ( x.specifiers[0].isBatch ) {
				x.isBatch = true;
				x.name = x.specifiers[0].name;
			}
		} else {
			x.isNamed = true;
		}

		return x;
	}

	/**
	 * Generates a representation of an export declaration
	 * @param {object} node - the original AST node
	 * @param {string} source - the original source code
	 * @returns {object}
	 */
	function processExport ( node, source ) {
		var result, d;

		result = {
			node: node,
			start: node.start,
			end: node.end
		};

		if ( d = node.declaration ) {
			result.value = source.slice( d.start, d.end );
			result.valueStart = d.start;

			// Case 1: `export var foo = 'bar'`
			if ( d.type === 'VariableDeclaration' ) {
				result.hasDeclaration = true; // TODO remove in favour of result.type
				result.type = 'varDeclaration';
				result.name = d.declarations[0].id.name;
			}

			// Case 2: `export function foo () {...}`
			else if ( d.type === 'FunctionDeclaration' ) {
				result.hasDeclaration = true; // TODO remove in favour of result.type
				result.type = 'namedFunction';
				result.isDefault = !!node.default;
				result.name = d.id.name;
			}

			else if ( d.type === 'FunctionExpression' ) {
				result.hasDeclaration = true; // TODO remove in favour of result.type
				result.isDefault = true;

				// Case 3: `export default function foo () {...}`
				if ( d.id ) {
					result.type = 'namedFunction';
					result.name = d.id.name;
				}

				// Case 4: `export default function () {...}`
				else {
					result.type = 'anonFunction';
				}
			}

			// Case 5: `export class Foo {...}`
			else if ( d.type === 'ClassDeclaration' ) {
				result.hasDeclaration = true; // TODO remove in favour of result.type
				result.type = 'namedClass';
				result.isDefault = !!node.default;
				result.name = d.id.name;
			}

			else if ( d.type === 'ClassExpression' ) {
				result.hasDeclaration = true; // TODO remove in favour of result.type
				result.isDefault = true;

				// Case 6: `export default class Foo {...}`
				if ( d.id ) {
					result.type = 'namedClass';
					result.name = d.id.name;
				}

				// Case 7: `export default class {...}`
				else {
					result.type = 'anonClass';
				}
			}

			// Case 8: `export default 1 + 2`
			else {
				result.type = 'expression';
				result.isDefault = true;
				result.name = 'default';
			}
		}

		// Case 9: `export { foo, bar };`
		else {
			result.type = 'named';
			result.specifiers = node.specifiers.map( function(s ) {return { name: s.id.name }}  ); // TODO as?
		}

		return result;
	}

	var reserved = 'break case class catch const continue debugger default delete do else export extends finally for function if import in instanceof let new return super switch this throw try typeof var void while with yield'.split( ' ' );

	/**
	 * Generates a sanitized (i.e. valid identifier) name from a module ID
	 * @param {string} id - a module ID, or part thereof
	 * @returns {string}
	 */
	function sanitize ( name ) {
		name = name.replace( /[^a-zA-Z0-9_$]/g, '_' );
		if ( /[^a-zA-Z_$]/.test( name[0] ) ) {
			name = '_' + name;
		}

		if ( ~reserved.indexOf( name ) ) {
			name = '_' + name;
		}

		return name;
	}

	var pathSplitRE = /\/|\\/;
	function splitPath ( path ) {
		return path.split( pathSplitRE );
	}

	function getModuleNameHelper ( userFn ) {var usedNames = arguments[1];if(usedNames === void 0)usedNames = {};
		var nameById = {}, getModuleName;

		getModuleName = function(x ) {
			var moduleId, parts, i, prefix = '', name, candidate;

			moduleId = x.path;

			// use existing value
			if ( hasOwnProp.call( nameById, moduleId ) ) {
				return nameById[ moduleId ];
			}

			// if user supplied a function, defer to it
			if ( userFn && ( name = userFn( moduleId ) ) ) {
				name = sanitize( name );

				if ( hasOwnProp.call( usedNames, name ) ) {
					// TODO write a test for this
					throw new Error( 'Naming collision: module ' + moduleId + ' cannot be called ' + name );
				}
			}

			else if ( x.isDefault || x.isBatch ) {
				name = x.name;
			}

			else {
				parts = splitPath( moduleId );
				i = parts.length;

				do {
					while ( i-- ) {
						candidate = prefix + sanitize( parts.slice( i ).join( '__' ) );

						if ( !hasOwnProp.call( usedNames, candidate ) ) {
							name = candidate;
							break;
						}
					}

					prefix += '_';
				} while ( !name );
			}

			usedNames[ name ] = true;
			nameById[ moduleId ] = name;

			return name;
		};

		return getModuleName;
	}

	function getStandaloneModule ( options ) {var $D$0;
		var mod, imports, exports;

		mod = {
			body: new MagicString( options.source ),
			ast: acorn.parse( options.source, {
				ecmaVersion: 6,
				locations: true
			})
		};

		if ( options.strict ) {
			annotateAst( mod.ast );
		}

		mod.getName = getModuleNameHelper( options.getModuleName, mod.ast._declared );

		imports = ($D$0 = findImportsAndExports( mod, options.source, mod.ast ))[0], exports = $D$0[1], $D$0;

		mod.imports = imports;
		mod.exports = exports;

		return mod;
	;$D$0 = void 0}

	function transformExportDeclaration ( declaration, body ) {
		var exportedValue;

		if ( declaration ) {
			switch ( declaration.type ) {
				case 'namedFunction':
				case 'namedClass':
					body.remove( declaration.start, declaration.valueStart );
					exportedValue = declaration.name;
					break;

				case 'anonFunction':
				case 'anonClass':
					if ( declaration.isFinal ) {
						body.replace( declaration.start, declaration.valueStart, 'return ' );
					} else {
						body.replace( declaration.start, declaration.valueStart, 'var __export = ' );
						exportedValue = '__export';
					}

					// add semi-colon, if necessary
					if ( declaration.value.slice( -1 ) !== ';' ) {
						body.insert( declaration.end, ';' );
					}

					break;

				case 'expression':
					body.remove( declaration.start, declaration.next );
					exportedValue = declaration.value;
					break;

				default:
					throw new Error( 'Unexpected export type' );
			}

			if ( exportedValue ) {
				body.append( '\nreturn ' + exportedValue + ';' );
			}
		}
	}

	var warned = {};

	function packageResult ( body, options, methodName, isBundle ) {
		var code, map;

		// wrap output
		if ( options.banner ) body.prepend( options.banner );
		if ( options.footer ) body.append( options.footer );

		code = body.toString();

		if ( !!options.sourceMap ) {
			if ( !options.sourceMapFile || ( !isBundle && !options.sourceMapSource )  ) {
				throw new Error( 'You must provide `sourceMapSource` and `sourceMapFile` options' );
			}

			map = body.generateMap({
				includeContent: true,
				hires: true,
				file: options.sourceMapFile,
				source: !isBundle ? getRelativePath( options.sourceMapFile, options.sourceMapSource ) : null
			});

			if ( options.sourceMap === 'inline' ) {
				code += '\n//# sourceMa' + 'ppingURL=' + map.toUrl();
				map = null;
			} else {
				code += '\n//# sourceMa' + 'ppingURL=./' + splitPath( options.sourceMapFile ).pop() + '.map';
			}
		} else {
			map = null;
		}

		return {
			code: code,
			map: map,
			toString: function () {
				if ( !warned[ methodName ] ) {
					console.log( 'Warning: esperanto.' + methodName + '() returns an object with a \'code\' property. You should use this instead of using the returned value directly' );
					warned[ methodName ] = true;
				}

				return code;
			}
		};
	}

	function getRelativePath ( from, to ) {
		var fromParts, toParts, i;

		fromParts = splitPath( from );
		toParts = splitPath( to );

		fromParts.pop(); // get dirname

		while ( fromParts[0] === toParts[0] ) {
			fromParts.shift();
			toParts.shift();
		}

		if ( fromParts.length ) {
			i = fromParts.length;
			while ( i-- ) fromParts[i] = '..';

			return fromParts.concat( toParts ).join( '/' );
		} else {
			toParts.unshift( '.' );
			return toParts.join( '/' );
		}
	}

	/**
	 * Reorders an array of imports so that empty imports (those with
	   no specifier, e.g. `import 'polyfills'`) are at the end. That
	   way they can be excluded from the factory function's arguments
	 * @param {array} imports - the imports to reorder
	 */
	function reorderImports ( imports ) {
		var i = imports.length, x;

		while ( i-- ) {
			x = imports[i];

			if ( x.isEmpty ) {
				imports.splice( i, 1 );
				imports.push( x );
			}
		}
	}

	/**
	 * Creates a template function from a template string. The template
	   may have `<%= someVar %>` interpolators, and the returned function
	   should be called with a data object e.g. `{ someVar: 'someData' }`
	 * @param {string} str - the template string
	 * @returns {function}
	 */
	function template ( str ) {
		return function ( data ) {
			return str.replace( /<%=\s*([^\s]+)\s*%>/g, function ( match, $1 ) {
				return $1 in data ? data[ $1 ] : match;
			});
		};
	}

	function getId ( m ) {
		return m.id;
	}

	function getName ( m ) {
		return m.name;
	}

	function quote ( str ) {
		return "'" + JSON.stringify(str).slice(1, -1).replace(/'/g, "\\'") + "'";
	}

	function req ( path ) {
		return 'require(' + quote(path) + ')';
	}

	function globalify ( name ) {
		return 'global.' + name;
	}

	var amd__introTemplate = template( 'define(<%= amdName %><%= paths %>function (<%= names %>) {\n\n' );

	function amd__amd ( mod, body, options ) {
		var importNames = [],
			importPaths = [],
			intro,
			i;

		// ensure empty imports are at the end
		reorderImports( mod.imports );

		// gather imports, and remove import declarations
		mod.imports.forEach( function( x, i )  {
			importPaths[i] = x.path;

			if ( x.name ) {
				importNames[i] = x.name;
			}

			body.remove( x.start, x.next );
		});

		transformExportDeclaration( mod.exports[0], body );

		intro = amd__introTemplate({
			amdName: options.amdName ? (("'" + (options.amdName)) + "', ") : '',
			paths: importPaths.length ? '[' + importPaths.map( quote ).join( ', ' ) + '], ' : '',
			names: importNames.join( ', ' )
		});

		body.trim()
			.prepend( "'use strict';\n\n" )
			.trim()
			.indent()
			.prepend( intro )
			.append( '\n\n});' );

		return packageResult( body, options, 'toAmd' );
	}

	function cjs__cjs ( mod, body, options ) {
		var exportDeclaration;

		mod.imports.forEach( function(x ) {
			var replacement = x.isEmpty ? (("" + (req(x.path))) + ";") : (("var " + (x.name)) + (" = " + (req(x.path))) + ";");
			body.replace( x.start, x.end, replacement );
		});

		exportDeclaration = mod.exports[0];

		if ( exportDeclaration ) {
			switch ( exportDeclaration.type ) {
				case 'namedFunction':
				case 'namedClass':
					body.remove( exportDeclaration.start, exportDeclaration.valueStart );
					body.replace( exportDeclaration.end, exportDeclaration.end, (("\nmodule.exports = " + (exportDeclaration.node.declaration.id.name)) + ";") );
					break;

				case 'anonFunction':
				case 'anonClass':
				case 'expression':
					body.replace( exportDeclaration.start, exportDeclaration.valueStart, 'module.exports = ' );
					break;

				default:
					throw new Error( 'Unexpected export type' );
			}
		}

		body.prepend( "'use strict';\n\n" ).trimLines()

		return packageResult( body, options, 'toCjs' );
	}

	function standaloneUmdIntro ( options, indentStr ) {
		var amdName = options.amdName ?
			quote(options.amdName) + ", " :
			'';

		var intro =
	(("(function (factory) {\
\n		!(typeof exports === 'object' && typeof module !== 'undefined') &&\
\n		typeof define === 'function' && define.amd ? define(" + amdName) + "factory) :\
\n		factory()\
\n	}(function () { 'use strict';\
\n\
\n	");

		return intro.replace( /\t/g, indentStr );
	}

	function defaultUmdIntro ( options, indentStr ) {
		var hasExports = options.hasExports;

		var amdName = options.amdName ?
			quote(options.amdName) + ", " :
			'';
		var amdDeps = options.importPaths.length > 0 ?
			'[' + options.importPaths.map( quote ).join( ', ' ) + '], ' :
			'';
		var cjsDeps = options.importPaths.map( req ).join( ', ' );
		var globalDeps = options.importNames.map( globalify ).join( ', ' );
		var args = options.importNames.join( ', ' );

		var cjsExport =
			(hasExports ? 'module.exports = ' : '') + (("factory(" + cjsDeps) + ")");

		var globalExport =
			(hasExports ? (("global." + (options.name)) + " = ") : '') + (("factory(" + globalDeps) + ")");


		var intro =
	(("(function (global, factory) {\
\n		typeof exports === 'object' && typeof module !== 'undefined' ? " + cjsExport) + (" :\
\n		typeof define === 'function' && define.amd ? define(" + amdName) + ("" + amdDeps) + ("factory) :\
\n		" + globalExport) + ("\
\n	}(this, function (" + args) + ") { 'use strict';\
\n\
\n	");

		return intro.replace( /\t/g, indentStr );
	}

	function umd__umd ( mod, body, options ) {
		var importNames = [];
		var importPaths = [];

		if ( !options.name ) {
			throw new Error( 'You must supply a `name` option for UMD modules' );
		}

		var hasImports = mod.imports.length > 0;
		var hasExports = mod.exports.length > 0;

		var intro;
		if (!hasImports && !hasExports) {
			intro = standaloneUmdIntro({
				amdName: options.amdName,
			}, body.getIndentString() );
		} else {
			// ensure empty imports are at the end
			reorderImports( mod.imports );

			// gather imports, and remove import declarations
			mod.imports.forEach( function( x, i )  {
				importPaths[i] = x.path;

				if ( x.name ) {
					importNames[i] = x.name;
				}

				body.remove( x.start, x.next );
			});

			transformExportDeclaration( mod.exports[0], body );

			intro = defaultUmdIntro({
				hasExports: hasExports,
				importPaths: importPaths,
				importNames: importNames,
				amdName: options.amdName,
				name: options.name
			}, body.getIndentString() );
		}

		body.indent().prepend( intro ).trimLines().append( '\n\n}));' );

		return packageResult( body, options, 'toUmd' );
	}

	var defaultsMode = {
		amd: amd__amd,
		cjs: cjs__cjs,
		umd: umd__umd
	};

	function gatherImports ( imports, getName ) {
		var chains = {}, identifierReplacements = {};

		imports.forEach( function(x ) {
			var moduleName = getName( x );

			x.specifiers.forEach( function(s ) {
				var name, replacement;

				if ( s.isBatch ) {
					return;
				}

				name = s.as;
				replacement = moduleName + ( s.isDefault ? ("['default']") : ("." + (s.name)) );

				if ( !x.passthrough ) {
					identifierReplacements[ name ] = replacement;
				}

				chains[ name ] = replacement;
			});
		});

		return [ chains, identifierReplacements ];
	}

	function getExportNames ( exports ) {
		var result = {};

		exports.forEach( function(x ) {
			if ( x.isDefault ) return;

			if ( x.hasDeclaration ) {
				result[ x.name ] = x.name;
				return;
			}

			x.specifiers.forEach( function(s ) {
				result[ s.name ] = s.name;
			});
		});

		return result;
	}

	/**
	 * Scans an array of imports, and determines which identifiers
	   are readonly, and which cannot be assigned to. For example
	   you cannot `import foo from 'foo'` then do `foo = 42`, nor
	   can you `import * from 'foo'` then do `foo.answer = 42`
	 * @param {array} imports - the array of imports
	 * @returns {array} [ importedBindings, importedNamespaces ]
	 */
	function getReadOnlyIdentifiers ( imports ) {
		var importedBindings = {}, importedNamespaces = {};

		imports.forEach( function(x ) {
			if ( x.passthrough ) return;

			x.specifiers.forEach( function(s ) {
				if ( s.isBatch ) {
					importedNamespaces[ s.as ] = true;
				} else {
					importedBindings[ s.as ] = true;
				}
			});
		});

		return [ importedBindings, importedNamespaces ];
	}

	var bindingMessage = 'Cannot reassign imported binding ',
		namespaceMessage = 'Cannot reassign imported binding of namespace ';

	function disallowIllegalReassignment ( node, importedBindings, importedNamespaces, scope ) {
		var assignee, name, isNamespaceAssignment;

		if ( node.type === 'AssignmentExpression' ) {
			assignee = node.left;
		} else if ( node.type === 'UpdateExpression' ) {
			assignee = node.argument;
		} else {
			return; // not an assignment
		}

		if ( assignee.type === 'MemberExpression' ) {
			assignee = assignee.object;
			isNamespaceAssignment = true;
		}

		if ( assignee.type !== 'Identifier' ) {
			return; // not assigning to a binding
		}

		name = assignee.name;

		if ( hasOwnProp.call( isNamespaceAssignment ? importedNamespaces : importedBindings, name ) && !scope.contains( name ) ) {
			throw new Error( ( isNamespaceAssignment ? namespaceMessage : bindingMessage ) + '`' + name + '`' );
		}
	}

	function rewriteIdentifiers ( body, node, identifierReplacements, scope ) {
		var name, replacement;

		if ( node.type === 'Identifier' ) {
			name = node.name;
			replacement = hasOwnProp.call( identifierReplacements, name ) && identifierReplacements[ name ];

			// TODO unchanged identifiers shouldn't have got this far -
			// remove the `replacement !== name` safeguard once that's the case
			if ( replacement && replacement !== name && !scope.contains( name, true ) ) {
				// rewrite
				body.replace( node.start, node.end, replacement );
			}
		}
	}

	function rewriteExportAssignments ( body, node, exports, scope, alreadyExported, isTopLevelNode, capturedUpdates ) {
		var assignee, name, exportAs;

		if ( node.type === 'AssignmentExpression' ) {
			assignee = node.left;
		} else if ( node.type === 'UpdateExpression' ) {
			assignee = node.argument;
		} else {
			return; // not an assignment
		}

		if ( assignee.type !== 'Identifier' ) {
			return;
		}

		name = assignee.name;
		if ( exports && hasOwnProp.call( exports, name ) && ( exportAs = exports[ name ] ) ) {
			if ( !!capturedUpdates ) {
				capturedUpdates.push({
					name: name,
					exportAs: exportAs
				});
				return;
			}

			// special case - increment/decrement operators
			if ( node.operator === '++' || node.operator === '--' ) {
				body.replace( node.end, node.end, ((", exports." + exportAs) + (" = " + name) + "") );
			} else {
				body.replace( node.start, node.start, (("exports." + exportAs) + " = ") );
			}

			// keep track of what we've already exported - we don't need to
			// export it again later
			if ( isTopLevelNode ) {
				alreadyExported[ name ] = true;
			}
		}
	}

	function traverseAst ( ast, body, identifierReplacements, importedBindings, importedNamespaces, exportNames, alreadyExported ) {
		var scope = ast._scope,
			blockScope = ast._blockScope,
			capturedUpdates = null,
			previousCapturedUpdates = null;

		estraverse.traverse( ast, {
			enter: function ( node ) {
				// we're only interested in references, not property names etc
				if ( node._skip ) return this.skip();

				if ( node._scope ) {
					scope = node._scope;
				} else if ( node._blockScope ) {
					blockScope = node._blockScope;
				}

				// Special case: if you have a variable declaration that updates existing
				// bindings as a side-effect, e.g. `var a = b++`, where `b` is an exported
				// value, we can't simply append `exports.b = b` to the update (as we
				// normally would) because that would be syntactically invalid. Instead,
				// we capture the change and update the export (and any others) after the
				// variable declaration
				if ( node.type === 'VariableDeclaration' ) {
					previousCapturedUpdates = capturedUpdates;
					capturedUpdates = [];
					return;
				}

				// Catch illegal reassignments
				disallowIllegalReassignment( node, importedBindings, importedNamespaces, scope );

				// Rewrite assignments to exports. This call may mutate `alreadyExported`
				// and `capturedUpdates`, which are used elsewhere
				rewriteExportAssignments( body, node, exportNames, scope, alreadyExported, scope === ast._scope, capturedUpdates );

				// Replace identifiers
				rewriteIdentifiers( body, node, identifierReplacements, scope );

				// Replace top-level this with undefined ES6 8.1.1.5.4
				if ( node.type === 'ThisExpression' && node._topLevel ) {
					body.replace( node.start, node.end, 'undefined' );
				}
			},

			leave: function ( node ) {
				// Special case - see above
				if ( node.type === 'VariableDeclaration' ) {
					if ( capturedUpdates.length ) {
						body.insert( node.end, capturedUpdates.map( exportCapturedUpdate ).join( '' ) );
					}

					capturedUpdates = previousCapturedUpdates;
				}

				if ( node._scope ) {
					scope = scope.parent;
				} else if ( node._blockScope ) {
					blockScope = blockScope.parent;
				}
			}
		});
	}

	function exportCapturedUpdate ( c ) {
		return ((" exports." + (c.name)) + (" = " + (c.exportAs)) + ";");
	}

	function transformBody ( mod, body, options ) {var $D$1;
		var chains,
			identifierReplacements,
			importedBindings = {},
			importedNamespaces = {},
			exportNames,
			alreadyExported = {},
			shouldExportEarly = {},
			earlyExports,
			lateExports;

		chains = ($D$1 = gatherImports( mod.imports, mod.getName ))[0], identifierReplacements = $D$1[1], $D$1;
		exportNames = getExportNames( mod.exports );

		importedBindings = ($D$1 = getReadOnlyIdentifiers( mod.imports ))[0], importedNamespaces = $D$1[1], $D$1;

		traverseAst( mod.ast, body, identifierReplacements, importedBindings, importedNamespaces, exportNames, alreadyExported );

		// Remove import statements from the body of the module
		mod.imports.forEach( function(x ) {
			if ( x.passthrough ) {
				// this is an `export { foo } from './bar'` statement -
				// it will be dealt with in the next section
				return;
			}

			body.remove( x.start, x.next );
		});

		// Prepend require() statements (CommonJS output only)
		if ( options.header ) {
			body.prepend( options.header + '\n\n' );
		}

		// Remove export statements (but keep declarations)
		mod.exports.forEach( function(x ) {
			switch ( x.type ) {
				case 'varDeclaration': // export var answer = 42;
					body.remove( x.start, x.valueStart );
					return;

				case 'namedFunction':
				case 'namedClass':
					if ( x.isDefault ) {
						// export default function answer () { return 42; }
						body.remove( x.start, x.valueStart );
						body.insert( x.end, (("\nexports['default'] = " + (x.name)) + ";") );
					} else {
						// export function answer () { return 42; }
						body.remove( x.start, x.valueStart );
					}
					return;

				case 'anonFunction':   // export default function () {}
				case 'anonClass':      // export default class () {}
				case 'expression':     // export default 40 + 2;
					body.replace( x.start, x.valueStart, 'exports[\'default\'] = ' );
					return;

				case 'named':          // export { foo, bar };
					body.remove( x.start, x.next );
					break;

				default:
					throw new Error( 'Unknown export type: ' + x.type );
			}
		});

		// Append export block (this is the same for all module types, unlike imports)
		earlyExports = [];
		lateExports = [];

		Object.keys( exportNames ).forEach( function(name ) {
			var exportAs = exportNames[ name ];

			if ( chains.hasOwnProperty( name ) ) {
				// special case - a binding from another module
				earlyExports.push( (("Object.defineProperty(exports, '" + exportAs) + ("', { get: function () { return " + (chains[name])) + "; }});") );
			} else if ( ~mod.ast._topLevelFunctionNames.indexOf( name ) ) {
				// functions should be exported early, in
				// case of cyclic dependencies
				earlyExports.push( (("exports." + exportAs) + (" = " + name) + ";") );
			} else if ( !alreadyExported.hasOwnProperty( name ) ) {
				lateExports.push( (("exports." + exportAs) + (" = " + name) + ";") );
			}
		});

		// Function exports should be exported immediately after 'use strict'
		if ( earlyExports.length ) {
			body.trim().prepend( earlyExports.join( '\n' ) + '\n\n' );
		}

		// Everything else should be exported at the end
		if ( lateExports.length ) {
			body.trim().append( '\n\n' + lateExports.join( '\n' ) );
		}

		if ( options.intro && options.outro ) {
			body.indent().prepend( options.intro ).trimLines().append( options.outro );
		}
	;$D$1 = void 0}

	function getImportSummary ( mod ) {
		var importPaths = [], importNames = [];

		mod.imports.forEach( function( x, i )  {
			importPaths[i] = x.path;

			if ( x.specifiers.length ) { // don't add empty imports
				importNames[i] = mod.getName( x );
			}
		});

		return [ importPaths, importNames ];
	}

	var strictMode_amd__introTemplate;

	strictMode_amd__introTemplate = template( 'define(<%= amdName %><%= paths %>function (<%= names %>) {\n\n\t\'use strict\';\n\n' );

	function strictMode_amd__amd ( mod, body, options ) {var $D$2;
		var importPaths,
			importNames,
			intro;

		// ensure empty imports are at the end
		reorderImports( mod.imports );

		importPaths = ($D$2 = getImportSummary( mod ))[0], importNames = $D$2[1], $D$2;

		if ( mod.exports.length ) {
			importPaths.unshift( 'exports' );
			importNames.unshift( 'exports' );
		}

		intro = strictMode_amd__introTemplate({
			amdName: options.amdName ? (("'" + (options.amdName)) + "', ") : '',
			paths: importPaths.length ? '[' + importPaths.map( quote ).join( ', ' ) + '], ' : '',
			names: importNames.join( ', ' )
		}).replace( /\t/g, body.getIndentString() );

		transformBody( mod, body, {
			intro: intro,
			outro: '\n\n});'
		});

		return packageResult( body, options, 'toAmd' );
	;$D$2 = void 0}

	function strictMode_cjs__cjs ( mod, body, options ) {
		var importBlock;

		// Create block of require statements
		importBlock = mod.imports.map( function(x ) {
			var name, replacement;

			if ( x.isEmpty ) {
				replacement = (("" + (req(x.path))) + ";");
			} else {
				name = mod.getName( x );
				replacement = (("var " + name) + (" = " + (req(x.path))) + ";");
			}

			return replacement;
		}).join( '\n' );

		transformBody( mod, body, {
			header: importBlock,
		});

		body.prepend( "'use strict';\n\n" ).trimLines()

		return packageResult( body, options, 'toCjs' );
	}

	function strictUmdIntro ( options, indentStr ) {
		var hasExports = options.hasExports;

		var amdName = options.amdName ?
			"'" + options.amdName + "', " :
			'';
		var amdDeps = hasExports || options.importPaths.length > 0 ?
			'[' +
				( hasExports ? [ 'exports' ] : [] ).concat( options.importPaths ).map( quote ).join( ', ' ) +
			'], ' :
			'';
		var cjsDeps = ( hasExports ? [ 'exports' ] : [] ).concat( options.importPaths.map( req ) ).join( ', ' );
		var globalDeps = ( hasExports ? [ (("(global." + (options.name)) + " = {})") ] : [] )
			.concat( options.importNames.map( globalify ) ).join( ', ' );
		var args = ( hasExports ? [ 'exports' ] : [] ).concat( options.importNames ).join( ', ' );

		var defaultsBlock = '';
		if ( options.externalDefaults && options.externalDefaults.length > 0 ) {
			defaultsBlock = options.externalDefaults.map( function(x )
				{return '\t' + ( x.needsNamed ? (("var " + (x.name)) + "__default") : x.name ) +
					((" = ('default' in " + (x.name)) + (" ? " + (x.name)) + ("['default'] : " + (x.name)) + ");")}
			).join('\n') + '\n\n';
		}

		var intro =
	(("(function (global, factory) {\
\n		typeof exports === 'object' && typeof module !== 'undefined' ? factory(" + cjsDeps) + (") :\
\n		typeof define === 'function' && define.amd ? define(" + amdName) + ("" + amdDeps) + ("factory) :\
\n		factory(" + globalDeps) + (")\
\n	}(this, function (" + args) + (") { 'use strict';\
\n\
\n	" + defaultsBlock) + "")

		return intro.replace( /\t/g, indentStr );
	}

	function strictMode_umd__umd ( mod, body, options ) {
		if ( !options.name ) {
			throw new Error( 'You must supply a `name` option for UMD modules' );
		}

		reorderImports( mod.imports );

		var importPaths = (importNames = getImportSummary( mod ))[0], importNames = importNames[1];

		var hasImports = mod.imports.length > 0;
		var hasExports = mod.exports.length > 0;

		var intro;
		if (!hasImports && !hasExports) {
			intro = standaloneUmdIntro({
				amdName: options.amdName,
			}, body.getIndentString() );
		} else {
			intro = strictUmdIntro({
				hasExports: hasExports,
				importPaths: importPaths,
				importNames: importNames,
				amdName: options.amdName,
				name: options.name,
			}, body.getIndentString() );
		}

		transformBody( mod, body, {
			intro: intro,
			outro: '\n\n}));'
		});

		return packageResult( body, options, 'toUmd' );
	}

	var strictMode = {
		amd: strictMode_amd__amd,
		cjs: strictMode_cjs__cjs,
		umd: strictMode_umd__umd
	};

	// TODO rewrite with named imports/exports
	var moduleBuilders = {
		defaultsMode: defaultsMode,
		strictMode: strictMode
	};

	var defaultsMode_amd__introTemplate = template( 'define(<%= amdName %><%= amdDeps %>function (<%= names %>) {\n\n\t\'use strict\';\n\n' );

	function defaultsMode_amd__amd ( bundle, body, options ) {
		var defaultName = bundle.entryModule.identifierReplacements.default;
		if ( defaultName ) {
			body.append( (("\n\nreturn " + defaultName) + ";") );
		}

		var intro = defaultsMode_amd__introTemplate({
			amdName: options.amdName ? (("" + (quote(options.amdName))) + ", ") : '',
			amdDeps: bundle.externalModules.length ? '[' + bundle.externalModules.map( quoteId ).join( ', ' ) + '], ' : '',
			names: bundle.externalModules.map( getName ).join( ', ' )
		}).replace( /\t/g, body.getIndentString() );

		body.indent().prepend( intro ).trimLines().append( '\n\n});' );
		return packageResult( body, options, 'toAmd', true );
	}

	function quoteId ( m ) {
		return "'" + m.id + "'";
	}

	function defaultsMode_cjs__cjs ( bundle, body, options ) {
		var importBlock = bundle.externalModules.map( function(x ) {
			return (("var " + (x.name)) + (" = " + (req(x.id))) + ";");
		}).join( '\n' );

		if ( importBlock ) {
			body.prepend( importBlock + '\n\n' );
		}

		var defaultName = bundle.entryModule.identifierReplacements.default;
		if ( defaultName ) {
			body.append( (("\n\nmodule.exports = " + defaultName) + ";") );
		}

		body.prepend("'use strict';\n\n").trimLines();

		return packageResult( body, options, 'toCjs', true );
	}

	function defaultsMode_umd__umd ( bundle, body, options ) {
		if ( !options || !options.name ) {
			throw new Error( 'You must specify an export name, e.g. `bundle.toUmd({ name: "myModule" })`' );
		}

		var entry = bundle.entryModule;

		var hasImports = bundle.externalModules.length > 0;
		var hasExports = entry.exports.length > 0;

		var intro;
		if (!hasImports && !hasExports) {
			intro = standaloneUmdIntro({
				amdName: options.amdName,
			}, body.getIndentString() );
		} else {

			var defaultName = entry.identifierReplacements.default;
			if ( defaultName ) {
				body.append( (("\n\nreturn " + defaultName) + ";") );
			}

			var importPaths = bundle.externalModules.map( getId );
			var importNames = bundle.externalModules.map( getName );

			intro = defaultUmdIntro({
				hasExports: hasExports,
				importPaths: importPaths,
				importNames: importNames,
				amdName: options.amdName,
				name: options.name
			}, body.getIndentString() );
		}

		body.indent().prepend( intro ).trimLines().append('\n\n}));');

		return packageResult( body, options, 'toUmd', true );
	}

	var builders_defaultsMode = {
		amd: defaultsMode_amd__amd,
		cjs: defaultsMode_cjs__cjs,
		umd: defaultsMode_umd__umd
	};

	function getExportBlock ( entry ) {
		var name = entry.identifierReplacements.default;
		return (("exports['default'] = " + name) + ";");
	}

	var builders_strictMode_amd__introTemplate = template( 'define(<%= amdName %><%= amdDeps %>function (<%= names %>) {\n\n\t\'use strict\';\n\n' );

	function builders_strictMode_amd__amd ( bundle, body, options ) {
		var externalDefaults = bundle.externalModules.filter( builders_strictMode_amd__needsDefault );
		var entry = bundle.entryModule;

		var importIds = bundle.externalModules.map( getId );
		var importNames = bundle.externalModules.map( getName );

		if ( externalDefaults.length ) {
			var defaultsBlock = externalDefaults.map( function(x ) {
				// Case 1: default is used, and named is not
				if ( !x.needsNamed ) {
					return (("" + (x.name)) + (" = ('default' in " + (x.name)) + (" ? " + (x.name)) + ("['default'] : " + (x.name)) + ");");
				}

				// Case 2: both default and named are used
				return (("var " + (x.name)) + ("__default = ('default' in " + (x.name)) + (" ? " + (x.name)) + ("['default'] : " + (x.name)) + ");");
			}).join( '\n' );

			body.prepend( defaultsBlock + '\n\n' );
		}

		if ( entry.exports.length ) {
			importIds.unshift( 'exports' );
			importNames.unshift( 'exports' );

			if ( entry.defaultExport ) {
				body.append( '\n\n' + getExportBlock( entry ) );
			}
		}

		var intro = builders_strictMode_amd__introTemplate({
			amdName: options.amdName ? (("" + (quote(options.amdName))) + ", ") : '',
			amdDeps: importIds.length ? '[' + importIds.map( quote ).join( ', ' ) + '], ' : '',
			names: importNames.join( ', ' )
		}).replace( /\t/g, body.getIndentString() );

		body.indent().prepend( intro ).trimLines().append( '\n\n});' );
		return packageResult( body, options, 'toAmd', true );
	}

	function builders_strictMode_amd__needsDefault ( externalModule ) {
		return externalModule.needsDefault;
	}

	function builders_strictMode_cjs__cjs ( bundle, body, options ) {
		var entry = bundle.entryModule;

		var importBlock = bundle.externalModules.map( function(x ) {
			var statement = (("var " + (x.name)) + (" = " + (req(x.id))) + ";");

			if ( x.needsDefault ) {
				statement += '\n' +
					( x.needsNamed ? (("var " + (x.name)) + "__default") : x.name ) +
					((" = ('default' in " + (x.name)) + (" ? " + (x.name)) + ("['default'] : " + (x.name)) + ");");
			}

			return statement;
		}).join( '\n' );

		if ( importBlock ) {
			body.prepend( importBlock + '\n\n' );
		}

		if ( entry.defaultExport ) {
			body.append( '\n\n' + getExportBlock( entry ) );
		}

		body.prepend("'use strict';\n\n").trimLines();

		return packageResult( body, options, 'toCjs', true );
	}

	function builders_strictMode_umd__umd ( bundle, body, options ) {
		if ( !options || !options.name ) {
			throw new Error( 'You must specify an export name, e.g. `bundle.toUmd({ name: "myModule" })`' );
		}

		var entry = bundle.entryModule;

		var hasImports = bundle.externalModules.length > 0;
		var hasExports = entry.exports.length > 0;

		var intro;
		if (!hasImports && !hasExports) {
			intro = standaloneUmdIntro({
				amdName: options.amdName,
			}, body.getIndentString() );
		} else {

			if ( hasExports && entry.defaultExport ) {
				body.append( '\n\n' + getExportBlock( entry ) );
			}

			var importPaths = bundle.externalModules.map( getId );
			var importNames = bundle.externalModules.map( getName );

			intro = strictUmdIntro({
				hasExports: hasExports,
				importPaths: importPaths,
				importNames: importNames,
				externalDefaults: bundle.externalModules.filter( builders_strictMode_umd__needsDefault ),
				amdName: options.amdName,
				name: options.name,
			}, body.getIndentString() );
		}

		body.indent().prepend( intro ).trimLines().append('\n\n}));');

		return packageResult( body, options, 'toUmd', true );
	}

	function builders_strictMode_umd__needsDefault ( externalModule ) {
		return externalModule.needsDefault;
	}

	var builders_strictMode = {
		amd: builders_strictMode_amd__amd,
		cjs: builders_strictMode_cjs__cjs,
		umd: builders_strictMode_umd__umd
	};

	// TODO rewrite with named imports/exports
	var bundleBuilders = {
		defaultsMode: builders_defaultsMode,
		strictMode: builders_strictMode
	};

	function concat ( bundle, options ) {
		var body, intro, outro, indent;

		// This bundle must be self-contained - no imports or exports
		if ( !options.ignoreExternal && (bundle.externalModules.length || bundle.entryModule.exports.length) ) {
			throw new Error( 'bundle.concat() can only be used with bundles that have no imports/exports' );
		}

		body = bundle.body.clone();

		// TODO test these options
		intro = 'intro' in options ? options.intro : ("(function () { 'use strict';\n\n");
		outro = 'outro' in options ? options.outro : '\n\n})();';

		if ( !( 'indent' in options ) || options.indent === true ) {
			indent = body.getIndentString();
		} else {
			indent = options.indent || '';
		}

		body.trimLines().indent( indent ).prepend( intro ).append( outro );

		return packageResult( body, options, 'toString', true );
	}

	var deprecateMessage = 'options.defaultOnly has been deprecated, and is now standard behaviour. To use named imports/exports, pass `strict: true`.',
		alreadyWarned = false;

	function transpileMethod ( format ) {
		return function ( source ) {var options = arguments[1];if(options === void 0)options = {};
			var mod,
				body,
				builder;

			mod = getStandaloneModule({ source: source, getModuleName: options.getModuleName, strict: options.strict });
			body = mod.body.clone();

			if ( 'defaultOnly' in options && !alreadyWarned ) {
				// TODO link to a wiki page explaining this, or something
				console.log( deprecateMessage );
				alreadyWarned = true;
			}

			if ( !options.strict ) {
				// ensure there are no named imports/exports. TODO link to a wiki page...
				if ( hasNamedImports( mod ) || hasNamedExports( mod ) ) {
					throw new Error( 'You must be in strict mode (pass `strict: true`) to use named imports or exports' );
				}

				builder = moduleBuilders.defaultsMode[ format ];
			} else {
				builder = moduleBuilders.strictMode[ format ];
			}

			return builder( mod, body, options );
		};
	}

	var esperanto = {
		toAmd: transpileMethod( 'amd' ),
		toCjs: transpileMethod( 'cjs' ),
		toUmd: transpileMethod( 'umd' ),

		bundle: function ( options ) {
			return undefined__default( options ).then( function ( bundle ) {
				return {
					toAmd: function(options ) {return transpile( 'amd', options )},
					toCjs: function(options ) {return transpile( 'cjs', options )},
					toUmd: function(options ) {return transpile( 'umd', options )},

					concat: function(options ) {return concat( bundle, options || {} )}
				};

				function transpile ( format, options ) {
					var builder;

					options = options || {};

					if ( 'defaultOnly' in options && !alreadyWarned ) {
						// TODO link to a wiki page explaining this, or something
						console.log( deprecateMessage );
						alreadyWarned = true;
					}

					if ( !options.strict ) {
						// ensure there are no named imports/exports
						if ( hasNamedExports( bundle.entryModule ) ) {
							throw new Error( 'Entry module can only have named exports in strict mode (pass `strict: true`)' );
						}

						bundle.modules.forEach( function(mod ) {
							mod.imports.forEach( function(x ) {
								if ( hasOwnProp.call( bundle.externalModuleLookup, x.id ) && ( !x.isDefault && !x.isBatch ) ) {
									throw new Error( 'You can only have named external imports in strict mode (pass `strict: true`)' );
								}
							});
						});

						builder = bundleBuilders.defaultsMode[ format ];
					} else {
						builder = bundleBuilders.strictMode[ format ];
					}

					return builder( bundle, bundle.body.clone(), options );
				}
			});
		}
	};

	return esperanto;

}));