// Licensed to Cloudera, Inc. under one
// or more contributor license agreements.  See the NOTICE file
// distributed with this work for additional information
// regarding copyright ownership.  Cloudera, Inc. licenses this file
// to you under the Apache License, Version 2.0 (the
// "License"); you may not use this file except in compliance
// with the License.  You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

var SqlParseSupport = (function () {

  // endsWith polyfill from hue_utils.js, needed as workers live in their own js environment
  if (!String.prototype.endsWith) {
    String.prototype.endsWith = function (searchString, position) {
      var subjectString = this.toString();
      if (typeof position !== 'number' || !isFinite(position) || Math.floor(position) !== position || position > subjectString.length) {
        position = subjectString.length;
      }
      position -= searchString.length;
      var lastIndex = subjectString.lastIndexOf(searchString, position);
      return lastIndex !== -1 && lastIndex === position;
    };
  }

  /**
   * Calculates the Optimal String Alignment distance between two strings. Returns 0 when the strings are equal and the
   * distance when not, distances is less than or equal to the length of the longest string.
   *
   * @param strA
   * @param strB
   * @param [ignoreCase]
   * @returns {number} The similarity
   */
  var stringDistance = function (strA, strB, ignoreCase) {
    if (ignoreCase) {
      strA = strA.toLowerCase();
      strB = strB.toLowerCase();
    }

    // TODO: Consider other algorithms for performance
    var strALength = strA.length;
    var strBLength = strB.length;
    if (strALength === 0) {
      return strBLength;
    }
    if (strBLength === 0) {
      return strALength;
    }

    var distances = new Array(strALength);

    var cost, deletion, insertion, substitution, transposition;
    for (var i = 0; i <= strALength; i++) {
      distances[i] = new Array(strBLength);
      distances[i][0] = i;
      for (var j = 1; j <= strBLength; j++) {
        if (!i){
          distances[0][j] = j;
        } else {
          cost = strA[i-1] === strB[j-1] ? 0 : 1;
          deletion = distances[i - 1][j] + 1;
          insertion = distances[i][j - 1] + 1;
          substitution = distances[i - 1][j - 1] + cost;
          if (deletion <= insertion && deletion <= substitution) {
            distances[i][j] = deletion;
          } else if (insertion <= deletion && insertion <= substitution) {
            distances[i][j] = insertion;
          } else {
            distances[i][j] = substitution;
          }

          if (i > 1 && j > 1 && strA[i] === strB[j - 1] && strA[i - 1] === strB[j]) {
            transposition = distances[i - 2][j - 2] + cost;
            if (transposition < distances[i][j]) {
              distances[i][j] = transposition;
            }
          }
        }
      }
    }

    return distances[strALength][strBLength];
  };

  var equalIgnoreCase = function (a, b) {
    return a && b && a.toLowerCase() === b.toLowerCase();
  };

  var initSqlParser = function (parser) {

    var SIMPLE_TABLE_REF_SUGGESTIONS = ['suggestJoinConditions', 'suggestAggregateFunctions', 'suggestFilters', 'suggestGroupBys', 'suggestOrderBys'];

    parser.prepareNewStatement = function () {
      linkTablePrimaries();
      parser.commitLocations();

      delete parser.yy.lateralViews;
      delete parser.yy.latestCommonTableExpressions;
      delete parser.yy.correlatedSubQuery;
      parser.yy.subQueries = [];
      parser.yy.selectListAliases = [];
      parser.yy.latestTablePrimaries = [];

      prioritizeSuggestions();
    };

    parser.yy.parseError = function (message, error) {
      parser.yy.errors.push(error);
      return message;
    };

    parser.addCommonTableExpressions = function (identifiers) {
      parser.yy.result.commonTableExpressions = identifiers;
      parser.yy.latestCommonTableExpressions = identifiers;
    };

    parser.isInSubquery = function () {
      return !!parser.yy.primariesStack.length
    };

    parser.pushQueryState = function () {
      parser.yy.resultStack.push(parser.yy.result);
      parser.yy.locationsStack.push(parser.yy.locations);
      parser.yy.lateralViewsStack.push(parser.yy.lateralViews);
      parser.yy.selectListAliasesStack.push(parser.yy.selectListAliases);
      parser.yy.primariesStack.push(parser.yy.latestTablePrimaries);
      parser.yy.subQueriesStack.push(parser.yy.subQueries);

      parser.yy.result = {};
      parser.yy.locations = [];
      parser.yy.selectListAliases = []; // Not allowed in correlated sub-queries
      parser.yy.lateralViews = []; // Not allowed in correlated sub-queries

      if (parser.yy.correlatedSubQuery) {
        parser.yy.latestTablePrimaries = parser.yy.latestTablePrimaries.concat();
        parser.yy.subQueries = parser.yy.subQueries.concat();
      } else {
        parser.yy.latestTablePrimaries = [];
        parser.yy.subQueries = [];
      }
    };

    parser.popQueryState = function (subQuery) {
      linkTablePrimaries();
      parser.commitLocations();

      if (Object.keys(parser.yy.result).length === 0) {
        parser.yy.result = parser.yy.resultStack.pop();
      } else {
        parser.yy.resultStack.pop();
      }
      var oldSubQueries = parser.yy.subQueries;
      parser.yy.subQueries = parser.yy.subQueriesStack.pop();
      if (subQuery) {
        if (oldSubQueries.length > 0) {
          subQuery.subQueries = oldSubQueries;
        }
        parser.yy.subQueries.push(subQuery);
      }

      parser.yy.lateralViews = parser.yy.lateralViewsStack.pop();
      parser.yy.latestTablePrimaries = parser.yy.primariesStack.pop();
      parser.yy.locations = parser.yy.locationsStack.pop();
      parser.yy.selectListAliases = parser.yy.selectListAliasesStack.pop();
    };

    parser.suggestSelectListAliases = function () {
      if (parser.yy.selectListAliases && parser.yy.selectListAliases.length > 0 && parser.yy.result.suggestColumns
        && (typeof parser.yy.result.suggestColumns.identifierChain === 'undefined' || parser.yy.result.suggestColumns.identifierChain.length === 0)) {
        parser.yy.result.suggestColumnAliases = parser.yy.selectListAliases;
      }
    };

    parser.isHive = function () {
      return parser.yy.activeDialect === 'hive';
    };

    parser.isImpala = function () {
      return parser.yy.activeDialect === 'impala';
    };

    parser.mergeSuggestKeywords = function () {
      var result = [];
      Array.prototype.slice.call(arguments).forEach(function (suggestion) {
        if (typeof suggestion !== 'undefined' && typeof suggestion.suggestKeywords !== 'undefined') {
          result = result.concat(suggestion.suggestKeywords);
        }
      });
      if (result.length > 0) {
        return {suggestKeywords: result};
      }
      return {};
    };

    parser.suggestValueExpressionKeywords = function (valueExpression, extras) {
      var expressionKeywords = parser.getValueExpressionKeywords(valueExpression, extras);
      parser.suggestKeywords(expressionKeywords.suggestKeywords);
      if (expressionKeywords.suggestColRefKeywords) {
        parser.suggestColRefKeywords(expressionKeywords.suggestColRefKeywords);
      }
      if (valueExpression.lastType) {
        parser.addColRefIfExists(valueExpression.lastType);
      } else {
        parser.addColRefIfExists(valueExpression);
      }
    };

    parser.getSelectListKeywords = function (excludeAsterisk) {
      var keywords = [{ value: 'CASE', weight: 450 }, 'FALSE', 'TRUE', 'NULL'];
      if (!excludeAsterisk) {
        keywords.push({ value: '*', weight: 10000 });
      }
      if (parser.isHive()) {
        keywords = keywords.concat(['EXISTS', 'NOT']);
      }
      return keywords;
    };

    parser.getValueExpressionKeywords = function (valueExpression, extras) {
      var types = valueExpression.lastType ? valueExpression.lastType.types : valueExpression.types;
      // We could have valueExpression.columnReference to suggest based on column type
      var keywords = ['<', '<=', '<=>', '<>', '=', '>', '>=', 'BETWEEN', 'IN', 'IS NOT NULL', 'IS NULL', 'IS NOT TRUE', 'IS TRUE', 'IS NOT FALSE', 'IS FALSE', 'NOT BETWEEN', 'NOT IN'];
      if (parser.isImpala()) {
        keywords = keywords.concat(['IS DISTINCT FROM', 'IS NOT DISTINCT FROM', 'IS NOT UNKNOWN', 'IS UNKNOWN']);
      }
      if (extras) {
        keywords = keywords.concat(extras);
      }
      if (valueExpression.suggestKeywords) {
        keywords = keywords.concat(valueExpression.suggestKeywords);
      }
      if (types.length === 1 && types[0] === 'COLREF') {
        return {
          suggestKeywords: keywords,
          suggestColRefKeywords: {
            BOOLEAN: ['AND', 'OR'],
            NUMBER: ['+', '-', '*', '/', '%', 'DIV'],
            STRING: parser.isImpala() ? ['ILIKE', 'IREGEXP', 'LIKE', 'NOT LIKE', 'REGEXP', 'RLIKE'] : ['LIKE', 'NOT LIKE', 'REGEXP', 'RLIKE']
          }
        }
      }
      if (typeof SqlFunctions === 'undefined' || SqlFunctions.matchesType(parser.yy.activeDialect, ['BOOLEAN'], types)) {
        keywords = keywords.concat(['AND', 'OR']);
      }
      if (typeof SqlFunctions === 'undefined' || SqlFunctions.matchesType(parser.yy.activeDialect, ['NUMBER'], types)) {
        keywords = keywords.concat(['+', '-', '*', '/', '%', 'DIV']);
      }
      if (typeof SqlFunctions === 'undefined' || SqlFunctions.matchesType(parser.yy.activeDialect, ['STRING'], types)) {
        keywords = keywords.concat(parser.isImpala() ? ['ILIKE', 'IREGEXP', 'LIKE', 'NOT LIKE', 'REGEXP', 'RLIKE'] : ['LIKE', 'NOT LIKE', 'REGEXP', 'RLIKE']);
      }
      return { suggestKeywords: keywords };
    };

    parser.getTypeKeywords = function () {
      if (parser.isHive()) {
        return ['BIGINT', 'BINARY', 'BOOLEAN', 'CHAR', 'DATE', 'DECIMAL', 'DOUBLE', 'DOUBLE PRECISION', 'FLOAT', 'INT', 'SMALLINT', 'TIMESTAMP', 'STRING', 'TINYINT', 'VARCHAR'];
      }
      if (parser.isImpala()) {
        return ['BIGINT', 'BOOLEAN', 'CHAR', 'DECIMAL', 'DOUBLE', 'FLOAT', 'INT', 'REAL', 'SMALLINT', 'TIMESTAMP', 'STRING', 'TINYINT', 'VARCHAR'];
      }
      return ['BIGINT', 'BOOLEAN', 'CHAR', 'DECIMAL', 'DOUBLE', 'FLOAT', 'INT', 'SMALLINT', 'TIMESTAMP', 'STRING', 'TINYINT', 'VARCHAR'];
    };

    parser.getColumnDataTypeKeywords = function () {
      if (parser.isHive()) {
        return parser.getTypeKeywords().concat(['ARRAY<>', 'MAP<>', 'STRUCT<>', 'UNIONTYPE<>']);
      }
      if (parser.isImpala()) {
        return parser.getTypeKeywords().concat(['ARRAY<>', 'MAP<>', 'STRUCT<>']);
      }
      return parser.getTypeKeywords();
    };

    parser.addColRefIfExists = function (valueExpression) {
      if (valueExpression.columnReference) {
        parser.yy.result.colRef = {identifierChain: valueExpression.columnReference};
      }
    };

    parser.selectListNoTableSuggest = function (selectListEdit, hasDistinctOrAll) {
      if (selectListEdit.cursorAtStart) {
        var keywords = parser.getSelectListKeywords();
        if (!hasDistinctOrAll) {
          keywords = keywords.concat([{ value: 'ALL', weight: 2 }, { value: 'DISTINCT', weight: 2 }]);
        }
        if (parser.isImpala()) {
          keywords.push('STRAIGHT_JOIN');
        }
        parser.suggestKeywords(keywords);
      } else {
        parser.checkForKeywords(selectListEdit);
      }
      if (selectListEdit.suggestFunctions) {
        parser.suggestFunctions();
      }
      if (selectListEdit.suggestColumns) {
        parser.suggestColumns();
      }
      if (selectListEdit.suggestAggregateFunctions && (!hasDistinctOrAll || hasDistinctOrAll === 'ALL')) {
        parser.suggestAggregateFunctions();
        parser.suggestAnalyticFunctions();
      }
    };

    parser.suggestJoinConditions = function (details) {
      parser.yy.result.suggestJoinConditions = details || {};
      if (parser.yy.latestTablePrimaries && !parser.yy.result.suggestJoinConditions.tablePrimaries) {
        parser.yy.result.suggestJoinConditions.tablePrimaries = parser.yy.latestTablePrimaries.concat();
      }
    };

    parser.suggestJoins = function (details) {
      parser.yy.result.suggestJoins = details || {};
    };

    parser.valueExpressionSuggest = function (oppositeValueExpression, operator) {
      if (oppositeValueExpression && oppositeValueExpression.columnReference) {
        parser.suggestValues();
        parser.yy.result.colRef = {identifierChain: oppositeValueExpression.columnReference};
      }
      parser.suggestColumns();
      parser.suggestFunctions();
      var keywords = [{ value: 'CASE', weight: 450 }, { value: 'FALSE', weight: 450 }, { value: 'NULL', weight: 450 }, { value: 'TRUE', weight: 450 }];
      if (parser.isHive() || typeof oppositeValueExpression === 'undefined' || typeof operator === 'undefined') {
        keywords = keywords.concat(['EXISTS', 'NOT']);
      }
      if (oppositeValueExpression && oppositeValueExpression.types[0] === 'NUMBER') {
        parser.applyTypeToSuggestions(['NUMBER']);
      } else if (parser.isImpala() && (typeof operator === 'undefined' || operator === '-' || operator === '+')) {
        keywords.push('INTERVAL');
      }
      parser.suggestKeywords(keywords);
    };

    parser.applyTypeToSuggestions = function (types) {
      if (types[0] === 'BOOLEAN') {
        return;
      }
      if (parser.yy.result.suggestFunctions && !parser.yy.result.suggestFunctions.types) {
        parser.yy.result.suggestFunctions.types = types;
      }
      if (parser.yy.result.suggestColumns && !parser.yy.result.suggestColumns.types) {
        parser.yy.result.suggestColumns.types = types;
      }
    };

    parser.findCaseType = function (whenThenList) {
      var types = {};
      whenThenList.caseTypes.forEach(function (valueExpression) {
        valueExpression.types.forEach(function (type) {
          types[type] = true;
        });
      });
      if (Object.keys(types).length === 1) {
        return {types: [Object.keys(types)[0]]};
      }
      return {types: ['T']};
    };

    parser.findReturnTypes = function (functionName) {
      return typeof SqlFunctions === 'undefined' ? ['T'] : SqlFunctions.getReturnTypes(parser.yy.activeDialect, functionName.toLowerCase());
    };

    parser.applyArgumentTypesToSuggestions = function (functionName, position) {
      var foundArguments = typeof SqlFunctions === 'undefined' ? ['T'] : SqlFunctions.getArgumentTypes(parser.yy.activeDialect, functionName.toLowerCase(), position);
      if (foundArguments.length == 0 && parser.yy.result.suggestColumns) {
        delete parser.yy.result.suggestColumns;
        delete parser.yy.result.suggestKeyValues;
        delete parser.yy.result.suggestValues;
        delete parser.yy.result.suggestFunctions;
        delete parser.yy.result.suggestIdentifiers;
        delete parser.yy.result.suggestKeywords;
      } else {
        parser.applyTypeToSuggestions(foundArguments);
      }
    };

    var getCleanImpalaPrimaries = function (primaries) {
      var cleanPrimaries = [];
      for (var i = primaries.length - 1; i >= 0; i--) {
        var cleanPrimary = primaries[i];
        if (cleanPrimary.identifierChain && cleanPrimary.identifierChain.length > 0) {
          for (var j = i - 1; j >=0; j--) {
            var parentPrimary = primaries[j];
            if (parentPrimary.alias && cleanPrimary.identifierChain[0].name === parentPrimary.alias) {
              var restOfChain = cleanPrimary.identifierChain.concat();
              restOfChain.shift();
              if (cleanPrimary.alias) {
                cleanPrimary = { identifierChain: parentPrimary.identifierChain.concat(restOfChain), alias: cleanPrimary.alias, impalaComplex: true };
              } else {
                cleanPrimary = { identifierChain: parentPrimary.identifierChain.concat(restOfChain), impalaComplex: true };
              }
            }
          }
        }
        cleanPrimaries.push(cleanPrimary);
      }
      return cleanPrimaries;
    };

    parser.commitLocations = function () {
      if (parser.yy.locations.length === 0) {
        return;
      }

      var tablePrimaries = parser.yy.latestTablePrimaries;

      if (parser.isImpala()) {
        tablePrimaries = [];
        getCleanImpalaPrimaries(parser.yy.latestTablePrimaries).forEach(function (primary) {
          var cleanPrimary = primary;
          if (primary.identifierChain && primary.identifierChain.length > 0) {
            for (var j = parser.yy.primariesStack.length - 1; j >= 0; j--) {
              getCleanImpalaPrimaries(parser.yy.primariesStack[j]).every(function (parentPrimary) {
                if (parentPrimary.alias && parentPrimary.alias === primary.identifierChain[0].name) {
                  var identifierChain = primary.identifierChain.concat();
                  identifierChain.shift();
                  cleanPrimary = { identifierChain: parentPrimary.identifierChain.concat(identifierChain) };
                  if (primary.alias) {
                    cleanPrimary.alias = primary.alias;
                  }
                  return false;
                }
                return true;
              });
            }
          }
          tablePrimaries.unshift(cleanPrimary);
        });
      }
      var i = parser.yy.locations.length;

      while (i--) {
        var location = parser.yy.locations[i];
        if (location.type === 'variable' && location.colRef) {
          parser.expandIdentifierChain({ wrapper: location.colRef, tablePrimaries: tablePrimaries, isColumnWrapper: true });
          delete location.colRef.linked;
        }

        // Impala can have references to previous tables after FROM, i.e. FROM testTable t, t.testArray
        // In this testArray would be marked a type table so we need to switch it to column.
        if (location.type === 'table' && typeof location.identifierChain !== 'undefined' && location.identifierChain.length > 1 && tablePrimaries) {
          var allPrimaries = tablePrimaries;
          parser.yy.primariesStack.forEach(function (parentPrimaries) {
            allPrimaries = getCleanImpalaPrimaries(parentPrimaries).concat(allPrimaries);
          });
          var found = allPrimaries.filter(function (primary) {
            return equalIgnoreCase(primary.alias, location.identifierChain[0].name);
          });
          if (found.length > 0) {
            location.type = 'column';
          }
        }

        if (location.type === 'database' && typeof location.identifierChain !== 'undefined' && location.identifierChain.length > 0 && tablePrimaries) {
          var allPrimaries = tablePrimaries;
          parser.yy.primariesStack.forEach(function (parentPrimaries) {
            allPrimaries = getCleanImpalaPrimaries(parentPrimaries).concat(allPrimaries);
          });
          var foundAlias = allPrimaries.filter(function (primary) {
            return equalIgnoreCase(primary.alias, location.identifierChain[0].name);
          });
          if (foundAlias.length > 0 && parser.isImpala()) {
            // Impala complex reference in FROM clause, i.e. FROM testTable t, t.testMap tm
            location.type = 'table';
            parser.expandIdentifierChain({ tablePrimaries: allPrimaries, wrapper: location, anyOwner: true });
            location.type = location.identifierChain.length === 1 ? 'table' : 'complex';
            continue;
          }
        }

        if (location.type === 'unknown') {
          if (typeof location.identifierChain !== 'undefined' && location.identifierChain.length > 0 && location.identifierChain.length <= 2 && tablePrimaries) {
            var found = tablePrimaries.filter(function (primary) {
              return equalIgnoreCase(primary.alias, location.identifierChain[0].name) || (primary.identifierChain && equalIgnoreCase(primary.identifierChain[0].name, location.identifierChain[0].name));
            });
            if (!found.length && location.firstInChain) {
              found = tablePrimaries.filter(function (primary) {
                return !primary.alias && primary.identifierChain && equalIgnoreCase(primary.identifierChain[primary.identifierChain.length - 1].name, location.identifierChain[0].name);
              });
            }

            if (found.length) {
              if (found[0].identifierChain.length > 1 && location.identifierChain.length === 1 && equalIgnoreCase(found[0].identifierChain[0].name, location.identifierChain[0].name)) {
                location.type = 'database';
              } else if (found[0].alias && equalIgnoreCase(location.identifierChain[0].name, found[0].alias) && location.identifierChain.length > 1) {
                location.type = 'column';
                parser.expandIdentifierChain({ tablePrimaries: tablePrimaries, wrapper: location, anyOwner: true });
              } else if (!found[0].alias && found[0].identifierChain && equalIgnoreCase(location.identifierChain[0].name, found[0].identifierChain[found[0].identifierChain.length - 1].name) && location.identifierChain.length > 1) {
                location.type = 'column';
                parser.expandIdentifierChain({ tablePrimaries: tablePrimaries, wrapper: location, anyOwner: true });
              } else {
                location.type = found[0].impalaComplex ? 'column' : 'table';
                parser.expandIdentifierChain({ tablePrimaries: tablePrimaries, wrapper: location, anyOwner: true });
              }
            } else {
              if (parser.yy.subQueries) {
                found = parser.yy.subQueries.filter(function (subQuery) {
                  return equalIgnoreCase(subQuery.alias, location.identifierChain[0].name);
                });
                if (found.length > 0) {
                  location.type = 'subQuery';
                  location.identifierChain = [{subQuery: found[0].alias}];
                }
              }
            }
          }
        }

        if (location.type === 'asterisk' && !location.linked) {

          if (tablePrimaries && tablePrimaries.length > 0) {
            location.tables = [];
            location.linked = false;
            if (!location.identifierChain) {
              location.identifierChain = [{ asterisk: true }];
            }
            parser.expandIdentifierChain({ tablePrimaries: tablePrimaries, wrapper: location, anyOwner: false });
            if (location.tables.length === 0) {
              parser.yy.locations.splice(i, 1);
            }
          } else {
            parser.yy.locations.splice(i, 1);
          }
        }

        if (location.type === 'table' && typeof location.identifierChain !== 'undefined' && location.identifierChain.length === 1 && location.identifierChain[0].name) {
          // Could be a cte reference
          parser.yy.locations.some(function (otherLocation) {
            if (otherLocation.type === 'alias' && otherLocation.source === 'cte' && SqlUtils.identifierEquals(otherLocation.alias, location.identifierChain[0].name)) {
              // TODO: Possibly add the other location if we want to show the link in the future.
              //       i.e. highlight select definition on hover over alias, also for subquery references.
              location.type = 'alias';
              location.target = 'cte';
              location.alias = location.identifierChain[0].name;
              delete location.identifierChain;
              return true;
            }
          });
        }

        if (location.type === 'table' && (typeof location.identifierChain === 'undefined' || location.identifierChain.length === 0)) {
          parser.yy.locations.splice(i, 1);
        }

        if (location.type === 'unknown') {
          location.type = 'column';
        }

        // A column location might refer to a previously defined alias, i.e. last 'foo' in "SELECT cast(id AS int) foo FROM tbl ORDER BY foo;"
        if (location.type === 'column') {
          for (var j = i - 1; j >= 0; j--) {
            var otherLocation = parser.yy.locations[j];
            if (otherLocation.type === 'alias' && otherLocation.source === 'column' && location.identifierChain && location.identifierChain.length === 1 && location.identifierChain[0].name && otherLocation.alias && location.identifierChain[0].name.toLowerCase() === otherLocation.alias.toLowerCase()) {
              location.type = 'alias';
              location.source = 'column';
              location.alias = location.identifierChain[0].name;
              delete location.identifierChain;
              location.parentLocation = otherLocation.parentLocation;
              break;
            }
          }
        }

        if (location.type === 'column') {
          if (parser.isHive() && !location.linked) {
            location.identifierChain = parser.expandLateralViews(parser.yy.lateralViews, location.identifierChain);
          }

          var initialIdentifierChain = location.identifierChain ? location.identifierChain.concat() : undefined;

          parser.expandIdentifierChain({ tablePrimaries: tablePrimaries, wrapper: location, anyOwner: true, isColumnWrapper: true, isColumnLocation: true });

          if (typeof location.identifierChain === 'undefined') {
            parser.yy.locations.splice(i, 1);
          } else if (location.identifierChain.length === 0 && initialIdentifierChain && initialIdentifierChain.length === 1) {
            // This is for the case "SELECT tblOrColName FROM db.tblOrColName";
            location.identifierChain = initialIdentifierChain;
          }
        }
        if (location.type === 'column' && location.identifierChain) {
          if (location.identifierChain.length > 1 && location.tables && location.tables.length > 0) {
            location.type = 'complex';
          }
        }
        delete location.firstInChain;
        if (location.type !== 'column' && location.type !== 'complex') {
          delete location.qualified;
        } else if (typeof location.qualified === 'undefined') {
          location.qualified = false;
        }
      }

      if (parser.yy.locations.length > 0) {
        parser.yy.allLocations = parser.yy.allLocations.concat(parser.yy.locations);
        parser.yy.locations = [];
      }
    };

    var prioritizeSuggestions = function () {
      parser.yy.result.lowerCase = parser.yy.lowerCase || false;

      var cteIndex = {};

      if (typeof parser.yy.latestCommonTableExpressions !== 'undefined') {
        parser.yy.latestCommonTableExpressions.forEach(function (cte) {
          cteIndex[cte.alias.toLowerCase()] = cte;
        })
      }

      SIMPLE_TABLE_REF_SUGGESTIONS.forEach(function (suggestionType) {
        if (suggestionType !== 'suggestAggregateFunctions' && typeof parser.yy.result[suggestionType] !== 'undefined' && parser.yy.result[suggestionType].tables.length === 0) {
          delete parser.yy.result[suggestionType];
        } else if (typeof parser.yy.result[suggestionType] !== 'undefined' && typeof parser.yy.result[suggestionType].tables !== 'undefined') {
          for (var i = parser.yy.result[suggestionType].tables.length - 1; i >= 0; i--) {
            var table = parser.yy.result[suggestionType].tables[i];
            if (table.identifierChain.length === 1 && typeof table.identifierChain[0].name !== 'undefined' && typeof cteIndex[table.identifierChain[0].name.toLowerCase()] !== 'undefined') {
              parser.yy.result[suggestionType].tables.splice(i, 1);
            }
          }
        }
      });

      if (typeof parser.yy.result.colRef !== 'undefined') {
        if (!parser.yy.result.colRef.linked || typeof parser.yy.result.colRef.identifierChain === 'undefined' || parser.yy.result.colRef.identifierChain.length === 0) {
          delete parser.yy.result.colRef;
          if (typeof parser.yy.result.suggestColRefKeywords !== 'undefined') {
            Object.keys(parser.yy.result.suggestColRefKeywords).forEach(function (type) {
              parser.yy.result.suggestKeywords = parser.yy.result.suggestKeywords.concat(parser.createWeightedKeywords(parser.yy.result.suggestColRefKeywords[type], -1));
            });
            delete parser.yy.result.suggestColRefKeywords;
          }
          if (parser.yy.result.suggestColumns && parser.yy.result.suggestColumns.types.length === 1 && parser.yy.result.suggestColumns.types[0] === 'COLREF') {
            parser.yy.result.suggestColumns.types = ['T'];
          }
          delete parser.yy.result.suggestValues;
        }
      }

      if (typeof parser.yy.result.colRef !== 'undefined') {
        if (!parser.yy.result.suggestValues && !parser.yy.result.suggestColRefKeywords &&
          (!parser.yy.result.suggestColumns ||
          parser.yy.result.suggestColumns.types[0] !== 'COLREF')) {
          delete parser.yy.result.colRef;
        }
      }
      if (typeof parser.yy.result.suggestIdentifiers !== 'undefined' && parser.yy.result.suggestIdentifiers.length > 0) {
        delete parser.yy.result.suggestTables;
        delete parser.yy.result.suggestDatabases;
      }
      if (typeof parser.yy.result.suggestColumns !== 'undefined') {
        var suggestColumns = parser.yy.result.suggestColumns;
        if (typeof suggestColumns.tables === 'undefined' || suggestColumns.tables.length === 0) {
          // Impala supports statements like SELECT * FROM tbl1, tbl2 WHERE db.tbl1.col = tbl2.bla
          if (parser.yy.result.suggestColumns.linked && parser.isImpala() && typeof suggestColumns.identifierChain !== 'undefined' && suggestColumns.identifierChain.length > 0) {
            if (suggestColumns.identifierChain.length === 1) {
              parser.yy.result.suggestTables = suggestColumns;
              delete parser.yy.result.suggestColumns
            } else {
              suggestColumns.tables = [{identifierChain: suggestColumns.identifierChain}];
              delete suggestColumns.identifierChain;
            }
          } else {
            delete parser.yy.result.suggestColumns;
            delete parser.yy.result.subQueries;
          }
        } else {
          delete parser.yy.result.suggestTables;
          delete parser.yy.result.suggestDatabases;

          suggestColumns.tables.forEach(function (table) {
            if (typeof table.identifierChain !== 'undefined' && table.identifierChain.length === 1 && typeof table.identifierChain[0].name !== 'undefined') {
              var cte = cteIndex[table.identifierChain[0].name.toLowerCase()];
              if (typeof cte !== 'undefined') {
                delete table.identifierChain[0].name;
                table.identifierChain[0].cte = cte.alias;
              }
            } else if (typeof table.identifierChain === 'undefined' && table.subQuery) {
              table.identifierChain = [{ subQuery: table.subQuery }];
              delete table.subQuery;
            }
          });

          if (typeof suggestColumns.identifierChain !== 'undefined' && suggestColumns.identifierChain.length === 0) {
            delete suggestColumns.identifierChain;
          }
        }
      } else {
        delete parser.yy.result.subQueries;
      }

      if (typeof parser.yy.result.suggestJoinConditions !== 'undefined') {
        if (typeof parser.yy.result.suggestJoinConditions.tables === 'undefined' || parser.yy.result.suggestJoinConditions.tables.length === 0) {
          delete parser.yy.result.suggestJoinConditions;
        }
      }

      if (typeof parser.yy.result.suggestTables !== 'undefined' && typeof parser.yy.latestCommonTableExpressions !== 'undefined') {
        var ctes = [];
        parser.yy.latestCommonTableExpressions.forEach(function (cte) {
          var suggestion = {name: cte.alias};
          if (parser.yy.result.suggestTables.prependFrom) {
            suggestion.prependFrom = true
          }
          if (parser.yy.result.suggestTables.prependQuestionMark) {
            suggestion.prependQuestionMark = true;
          }
          ctes.push(suggestion);
        });
        if (ctes.length > 0) {
          parser.yy.result.suggestCommonTableExpressions = ctes;
        }
      }
    };

    /**
     * Impala supports referencing maps and arrays in the the table reference list i.e.
     *
     *  SELECT m['foo'].bar.| FROM someDb.someTable t, t.someMap m;
     *
     * From this the tablePrimaries would look like:
     *
     * [ { alias: 't', identifierChain: [ { name: 'someDb' }, { name: 'someTable' } ] },
     *   { alias: 'm', identifierChain: [ { name: 't' }, { name: 'someMap' } ] } ]
     *
     * with an identifierChain from the select list:
     *
     * [ { name: 'm', keySet: true }, { name: 'bar' } ]
     *
     * Calling this would return an expanded identifierChain, given the above it would be:
     *
     * [ { name: 't' }, { name: 'someMap', keySet: true }, { name: 'bar' } ]
     */
    parser.expandImpalaIdentifierChain = function (tablePrimaries, identifierChain) {
      var expandedChain = identifierChain.concat(); // Clone in case it's called multiple times.
      if (typeof expandedChain === 'undefined' || expandedChain.length === 0) {
        return identifierChain;
      }
      var expand = function (identifier, expandedChain) {
        var foundPrimary = tablePrimaries.filter(function (tablePrimary) {
          var primaryIdentifier = tablePrimary.alias;
          if (!primaryIdentifier && tablePrimary.identifierChain && tablePrimary.identifierChain.length > 0) {
            primaryIdentifier = tablePrimary.identifierChain[tablePrimary.identifierChain.length - 1].name;
          }
          return equalIgnoreCase(primaryIdentifier, identifier);
        });

        if (foundPrimary.length === 1 && foundPrimary[0].identifierChain) {
          var parentPrimary = tablePrimaries.filter(function (tablePrimary) {
            return equalIgnoreCase(tablePrimary.alias, foundPrimary[0].identifierChain[0].name);
          });
          if (parentPrimary.length === 1) {
            var keySet = expandedChain[0].keySet;
            var secondPart = expandedChain.slice(1);
            var firstPart = [];
            // Clone to make sure we don't add keySet to the primaries
            foundPrimary[0].identifierChain.forEach(function (identifier) {
              firstPart.push({name: identifier.name});
            });
            if (keySet && firstPart.length > 0) {
              firstPart[firstPart.length - 1].keySet = true;
            }

            if (firstPart.length === 0 || typeof secondPart === 'undefined' || secondPart.length === 0) {
              return firstPart;
            }
            var result = firstPart.concat(secondPart);
            if (result.length > 0) {
              return expand(firstPart[0].name, result);
            } else {
              return result;
            }
          }
        }
        return expandedChain;
      };
      return expand(expandedChain[0].name, expandedChain);
    };

    parser.identifyPartials = function (beforeCursor, afterCursor) {
      var beforeMatch = beforeCursor.match(/[0-9a-zA-Z_]*$/);
      var afterMatch = afterCursor.match(/^[0-9a-zA-Z_]*(?:\((?:[^)]*\))?)?/);
      return {left: beforeMatch ? beforeMatch[0].length : 0, right: afterMatch ? afterMatch[0].length : 0};
    };

    parser.expandLateralViews = function (lateralViews, originalIdentifierChain, columnSuggestion) {
      var identifierChain = originalIdentifierChain.concat(); // Clone in case it's re-used
      var firstIdentifier = identifierChain[0];
      if (typeof lateralViews !== 'undefined') {
        lateralViews.concat().reverse().forEach(function (lateralView) {
          if (!lateralView.udtf.expression.columnReference) {
            return;
          }
          if (equalIgnoreCase(firstIdentifier.name, lateralView.tableAlias) && identifierChain.length > 1) {
            identifierChain.shift();
            firstIdentifier = identifierChain[0];
            if (columnSuggestion) {
              delete parser.yy.result.suggestKeywords;
            }
          } else if (equalIgnoreCase(firstIdentifier.name, lateralView.tableAlias) && identifierChain.length === 1 && typeof parser.yy.result.suggestColumns !== 'undefined') {
            if (columnSuggestion) {
              if (typeof parser.yy.result.suggestIdentifiers === 'undefined') {
                parser.yy.result.suggestIdentifiers = [];
              }
              lateralView.columnAliases.forEach(function (columnAlias) {
                parser.yy.result.suggestIdentifiers.push({name: columnAlias, type: 'alias'});
              });
              delete parser.yy.result.suggestColumns;
              delete parser.yy.result.suggestKeywords;
            }
            return identifierChain;
          }
          if (lateralView.columnAliases.indexOf(firstIdentifier.name) !== -1) {
            if (lateralView.columnAliases.length === 2 && lateralView.udtf.function.toLowerCase() === 'explode' && equalIgnoreCase(firstIdentifier.name, lateralView.columnAliases[0])) {
              identifierChain[0] = {name: 'key'};
            } else if (lateralView.columnAliases.length === 2 && lateralView.udtf.function.toLowerCase() === 'explode' && equalIgnoreCase(firstIdentifier.name, lateralView.columnAliases[1])) {
              identifierChain[0] = {name: 'value'};
            } else {
              identifierChain[0] = {name: 'item'};
            }
            identifierChain = lateralView.udtf.expression.columnReference.concat(identifierChain);
            firstIdentifier = identifierChain[0];
          }
        });
      }
      return identifierChain;
    };

    var addCleanTablePrimary = function (tables, tablePrimary) {
      if (tablePrimary.alias) {
        tables.push({alias: tablePrimary.alias, identifierChain: tablePrimary.identifierChain});
      } else {
        tables.push({identifierChain: tablePrimary.identifierChain});
      }
    };

    parser.expandIdentifierChain = function (options) {
      var wrapper = options.wrapper;
      var anyOwner = options.anyOwner;
      var isColumnWrapper = options.isColumnWrapper;
      var isColumnLocation = options.isColumnLocation;
      var tablePrimaries = options.tablePrimaries || parser.yy.latestTablePrimaries;

      if (typeof wrapper.identifierChain === 'undefined' || typeof tablePrimaries === 'undefined') {
        return;
      }
      var identifierChain = wrapper.identifierChain.concat();

      if (tablePrimaries.length === 0) {
        delete wrapper.identifierChain;
        return;
      }

      if (!anyOwner) {
        tablePrimaries = filterTablePrimariesForOwner(tablePrimaries, wrapper.owner);
      }

      if (identifierChain.length > 0 && identifierChain[identifierChain.length - 1].asterisk) {
        var tables = [];
        tablePrimaries.forEach(function (tablePrimary) {
          if (identifierChain.length > 1 && !tablePrimary.subQueryAlias) {
            if (identifierChain.length === 2 && equalIgnoreCase(tablePrimary.alias, identifierChain[0].name)) {
              addCleanTablePrimary(tables, tablePrimary);
            } else if (identifierChain.length === 2 && equalIgnoreCase(tablePrimary.identifierChain[0].name, identifierChain[0].name)) {
              addCleanTablePrimary(tables, tablePrimary);
            } else if (identifierChain.length === 3 && tablePrimary.identifierChain.length > 1 &&
              equalIgnoreCase(tablePrimary.identifierChain[0].name, identifierChain[0].name) &&
              equalIgnoreCase(tablePrimary.identifierChain[1].name, identifierChain[1].name)) {
              addCleanTablePrimary(tables, tablePrimary);
            }
          } else {
            if (tablePrimary.subQueryAlias) {
              tables.push({identifierChain: [{subQuery: tablePrimary.subQueryAlias}]});
            } else {
              addCleanTablePrimary(tables, tablePrimary);
            }
          }
        });
        // Possible Joins
        if (tables.length > 0) {
          wrapper.tables = tables;
          delete wrapper.identifierChain;
          return;
        }
      }

      // Impala can have references to maps or array, i.e. FROM table t, t.map m
      // We need to replace those in the identifierChain
      if (parser.isImpala()) {
        var lengthBefore = identifierChain.length;
        identifierChain = parser.expandImpalaIdentifierChain(tablePrimaries, identifierChain);
        // Change type of any locations marked as table
        if (wrapper.type === 'table' && identifierChain.length > lengthBefore) {
          wrapper.type = 'column';
        }
        wrapper.identifierChain = identifierChain;
      }
      // Expand exploded views in the identifier chain
      if (parser.isHive() && identifierChain.length > 0) {
        identifierChain = parser.expandLateralViews(parser.yy.lateralViews, identifierChain);
        wrapper.identifierChain = identifierChain;
      }

      // IdentifierChain contains a possibly started identifier or empty, example: a.b.c = ['a', 'b', 'c']
      // Reduce the tablePrimaries to the one that matches the first identifier if found
      var foundPrimary;
      var doubleMatch = false;
      var aliasMatch = false;
      if (identifierChain.length > 0) {
        for (var i = 0; i < tablePrimaries.length; i++) {
          if (tablePrimaries[i].subQueryAlias) {
            if (equalIgnoreCase(tablePrimaries[i].subQueryAlias, identifierChain[0].name)) {
              foundPrimary = tablePrimaries[i];
            }
          } else if (equalIgnoreCase(tablePrimaries[i].alias, identifierChain[0].name)) {
            foundPrimary = tablePrimaries[i];
            aliasMatch = true;
            break;
          } else if (tablePrimaries[i].identifierChain.length > 1 && identifierChain.length > 1 &&
            equalIgnoreCase(tablePrimaries[i].identifierChain[0].name, identifierChain[0].name) &&
            equalIgnoreCase(tablePrimaries[i].identifierChain[1].name, identifierChain[1].name)) {
            foundPrimary = tablePrimaries[i];
            doubleMatch = true;
            break;
          } else if (!foundPrimary && equalIgnoreCase(tablePrimaries[i].identifierChain[0].name, identifierChain[0].name) && identifierChain.length > (isColumnLocation ? 1 : 0)) {
            foundPrimary = tablePrimaries[i];
            // No break as first two can still match.
          } else if (!foundPrimary && tablePrimaries[i].identifierChain.length > 1 && !tablePrimaries[i].alias
            && equalIgnoreCase(tablePrimaries[i].identifierChain[tablePrimaries[i].identifierChain.length - 1].name, identifierChain[0].name)) {
            // This is for the case SELECT baa. FROM bla.baa, blo.boo;
            foundPrimary = tablePrimaries[i];
            break;
          }
        }
      }

      if (foundPrimary) {
        if (foundPrimary.impalaComplex && wrapper.type === 'column') {
          wrapper.type = 'complex';
        }
        identifierChain.shift();
        if (doubleMatch) {
          identifierChain.shift();
        }
      } else if (tablePrimaries.length === 1 && !isColumnWrapper) {
        foundPrimary = tablePrimaries[0];
      }

      if (foundPrimary) {
        if (isColumnWrapper) {
          wrapper.identifierChain = identifierChain;
          if (foundPrimary.subQueryAlias) {
            wrapper.tables = [{ subQuery: foundPrimary.subQueryAlias }];
          } else if (foundPrimary.alias) {
            if (!isColumnLocation && isColumnWrapper && aliasMatch) {
              // TODO: add alias on table in suggestColumns (needs support in sqlAutocomplete3.js)
              // the case is: SELECT cu.| FROM customers cu;
              // This prevents alias from being added automatically in sqlAutocompleter3.js
              wrapper.tables = [{ identifierChain: foundPrimary.identifierChain }];
            } else {
              wrapper.tables = [{ identifierChain: foundPrimary.identifierChain, alias: foundPrimary.alias }];
            }
          } else {
            wrapper.tables = [{ identifierChain: foundPrimary.identifierChain }];
          }
        } else {
          if (foundPrimary.subQueryAlias) {
            identifierChain.unshift({ subQuery: foundPrimary.subQueryAlias });
          } else {
            identifierChain = foundPrimary.identifierChain.concat(identifierChain);
          }
          if (wrapper.tables) {
            wrapper.tables.push({identifierChain: identifierChain});
            delete wrapper.identifierChain;
          } else {
            wrapper.identifierChain = identifierChain;
          }
        }
      } else {
        if (isColumnWrapper) {
          wrapper.tables = [];
        }
        tablePrimaries.forEach(function (tablePrimary) {
          var targetTable = tablePrimary.subQueryAlias ? { subQuery: tablePrimary.subQueryAlias } : { identifierChain: tablePrimary.identifierChain } ;
          if (tablePrimary.alias) {
            targetTable.alias = tablePrimary.alias;
          }
          if (wrapper.tables) {
            wrapper.tables.push(targetTable)
          }
        });
      }
      delete wrapper.owner;
      wrapper.linked = true;
    };

    var suggestLateralViewAliasesAsIdentifiers = function () {
      if (typeof parser.yy.lateralViews === 'undefined' || parser.yy.lateralViews.length === 0) {
        return;
      }
      if (typeof parser.yy.result.suggestIdentifiers === 'undefined') {
        parser.yy.result.suggestIdentifiers = [];
      }
      parser.yy.lateralViews.forEach(function (lateralView) {
        if (typeof lateralView.tableAlias !== 'undefined') {
          parser.yy.result.suggestIdentifiers.push({name: lateralView.tableAlias + '.', type: 'alias'});
        }
        lateralView.columnAliases.forEach(function (columnAlias) {
          parser.yy.result.suggestIdentifiers.push({name: columnAlias, type: 'alias'});
        });
      });
      if (parser.yy.result.suggestIdentifiers.length === 0) {
        delete parser.yy.result.suggestIdentifiers;
      }
    };

    var filterTablePrimariesForOwner = function (tablePrimaries, owner) {
      var result = [];
      tablePrimaries.forEach(function (primary) {
        if (typeof owner === 'undefined' && typeof primary.owner === 'undefined') {
          result.push(primary);
        } else if (owner === primary.owner) {
          result.push(primary);
        }
      });
      return result;
    };

    var convertTablePrimariesToSuggestions = function (tablePrimaries) {
      var tables = [];
      var identifiers = [];
      tablePrimaries.forEach(function (tablePrimary) {
        if (tablePrimary.identifierChain && tablePrimary.identifierChain.length > 0) {
          var table = {identifierChain: tablePrimary.identifierChain};
          if (tablePrimary.alias) {
            table.alias = tablePrimary.alias;
            identifiers.push({name: table.alias + '.', type: 'alias'});
            if (parser.isImpala()) {
              var testForImpalaAlias = [{name: table.alias}];
              var result = parser.expandImpalaIdentifierChain(tablePrimaries, testForImpalaAlias);
              if (result.length > 1) {
                // Continue if it's a reference to a complex type
                return;
              }
            }
          } else {
            var lastIdentifier = tablePrimary.identifierChain[tablePrimary.identifierChain.length - 1];
            if (typeof lastIdentifier.name !== 'undefined') {
              identifiers.push({name: lastIdentifier.name + '.', type: 'table'});
            } else if (typeof lastIdentifier.subQuery !== 'undefined') {
              identifiers.push({name: lastIdentifier.subQuery + '.', type: 'sub-query'});
            }
          }
          tables.push(table);
        } else if (tablePrimary.subQueryAlias) {
          identifiers.push({name: tablePrimary.subQueryAlias + '.', type: 'sub-query'});
          tables.push({identifierChain: [{subQuery: tablePrimary.subQueryAlias}]});
        }
      });
      if (identifiers.length > 0) {
        if (typeof parser.yy.result.suggestIdentifiers === 'undefined') {
          parser.yy.result.suggestIdentifiers = identifiers;
        } else {
          parser.yy.result.suggestIdentifiers = identifiers.concat(parser.yy.result.suggestIdentifiers);
        }
      }
      parser.yy.result.suggestColumns.tables = tables;
      if (parser.yy.result.suggestColumns.identifierChain && parser.yy.result.suggestColumns.identifierChain.length === 0) {
        delete parser.yy.result.suggestColumns.identifierChain;
      }
      parser.yy.result.suggestColumns.linked = true;
    };

    var linkTablePrimaries = function () {
      if (!parser.yy.cursorFound || typeof parser.yy.latestTablePrimaries === 'undefined') {
        return;
      }

      SIMPLE_TABLE_REF_SUGGESTIONS.forEach(function (suggestionType) {
        if (typeof parser.yy.result[suggestionType] !== 'undefined' && parser.yy.result[suggestionType].tablePrimaries && !parser.yy.result[suggestionType].linked) {
          parser.yy.result[suggestionType].tables = [];
          parser.yy.result[suggestionType].tablePrimaries.forEach(function (tablePrimary) {
            if (!tablePrimary.subQueryAlias) {
              parser.yy.result[suggestionType].tables.push(tablePrimary.alias ? {
                identifierChain: tablePrimary.identifierChain.concat(),
                alias: tablePrimary.alias
              } : {identifierChain: tablePrimary.identifierChain.concat()});
            }
          });
          delete parser.yy.result[suggestionType].tablePrimaries;
          parser.yy.result[suggestionType].linked = true;
        }
      });

      if (typeof parser.yy.result.suggestColumns !== 'undefined' && !parser.yy.result.suggestColumns.linked) {
        var tablePrimaries = filterTablePrimariesForOwner(parser.yy.latestTablePrimaries, parser.yy.result.suggestColumns.owner);
        if (!parser.yy.result.suggestColumns.tables) {
          parser.yy.result.suggestColumns.tables = [];
        }
        if (parser.yy.subQueries.length > 0) {
          parser.yy.result.subQueries = parser.yy.subQueries;
        }
        if (typeof parser.yy.result.suggestColumns.identifierChain === 'undefined' || parser.yy.result.suggestColumns.identifierChain.length === 0) {
          if (tablePrimaries.length > 1) {
            convertTablePrimariesToSuggestions(tablePrimaries);
          } else {
            suggestLateralViewAliasesAsIdentifiers();
            if (tablePrimaries.length === 1 && (tablePrimaries[0].alias || tablePrimaries[0].subQueryAlias)) {
              convertTablePrimariesToSuggestions(tablePrimaries);
            }
            parser.expandIdentifierChain({ wrapper: parser.yy.result.suggestColumns, anyOwner: false, isColumnWrapper: true });
          }
        } else {
          // Expand exploded views in the identifier chain
          if (parser.isHive() && !parser.yy.result.suggestColumns.linked) {
            var originalLength = parser.yy.result.suggestColumns.identifierChain.length;
            parser.yy.result.suggestColumns.identifierChain = parser.expandLateralViews(parser.yy.lateralViews, parser.yy.result.suggestColumns.identifierChain, true);
            // Drop '*' keyword for lateral views
            if (typeof parser.yy.result.suggestColumns !== 'undefined') {
              if (parser.yy.result.suggestColumns.identifierChain.length > originalLength &&
                typeof parser.yy.result.suggestKeywords !== 'undefined' &&
                parser.yy.result.suggestKeywords.length === 1 &&
                parser.yy.result.suggestKeywords[0].value === '*') {
                delete parser.yy.result.suggestKeywords;
              }
              parser.expandIdentifierChain({ wrapper: parser.yy.result.suggestColumns, anyOwner: false, isColumnWrapper: true });
            }
          } else {
            parser.expandIdentifierChain({ wrapper: parser.yy.result.suggestColumns, anyOwner: false, isColumnWrapper: true });
          }
        }
      }

      if (typeof parser.yy.result.colRef !== 'undefined' && !parser.yy.result.colRef.linked) {
        parser.expandIdentifierChain({ wrapper: parser.yy.result.colRef });

        var primaries = filterTablePrimariesForOwner(parser.yy.latestTablePrimaries);
        if (primaries.length === 0 || (primaries.length > 1 && parser.yy.result.colRef.identifierChain.length === 1)) {
          parser.yy.result.colRef.identifierChain = [];
        }
      }
      if (typeof parser.yy.result.suggestKeyValues !== 'undefined' && !parser.yy.result.suggestKeyValues.linked) {
        parser.expandIdentifierChain({ wrapper: parser.yy.result.suggestKeyValues });
      }
    };

    parser.getSubQuery = function (cols) {
      var columns = [];
      cols.selectList.forEach(function (col) {
        var result = {};
        if (col.alias) {
          result.alias = col.alias;
        }
        if (col.valueExpression && col.valueExpression.columnReference) {
          result.identifierChain = col.valueExpression.columnReference
        } else if (col.asterisk) {
          result.identifierChain = [{asterisk: true}];
        }
        if (col.valueExpression && col.valueExpression.types && col.valueExpression.types.length === 1) {
          result.type = col.valueExpression.types[0];
        }

        columns.push(result);
      });

      return {
        columns: columns
      };
    };

    parser.addTablePrimary = function (ref) {
      if (typeof parser.yy.latestTablePrimaries === 'undefined') {
        parser.yy.latestTablePrimaries = [];
      }
      parser.yy.latestTablePrimaries.push(ref);
    };

    parser.suggestFileFormats = function () {
      if (parser.isHive()) {
        parser.suggestKeywords(['AVRO', 'INPUTFORMAT', 'ORC', 'PARQUET', 'RCFILE', 'SEQUENCEFILE', 'TEXTFILE']);
      } else {
        parser.suggestKeywords(['AVRO', 'KUDU', 'ORC', 'PARQUET', 'RCFILE', 'SEQUENCEFILE', 'TEXTFILE']);
      }
    };

    parser.getKeywordsForOptionalsLR = function (optionals, keywords, override) {
      var result = [];

      for (var i = 0; i < optionals.length; i++) {
        if (!optionals[i] && (typeof override === 'undefined' || override[i])) {
          if (keywords[i] instanceof Array) {
            result = result.concat(keywords[i]);
          } else {
            result.push(keywords[i]);
          }
        } else if (optionals[i]) {
          break;
        }
      }
      return result;
    };

    parser.suggestDdlAndDmlKeywords = function (extraKeywords) {
      var keywords = ['ALTER', 'CREATE', 'DESCRIBE', 'DROP', 'GRANT', 'INSERT', 'REVOKE', 'SELECT', 'SET', 'SHOW', 'TRUNCATE', 'UPDATE', 'USE', 'WITH'];

      if (extraKeywords) {
        keywords = keywords.concat(extraKeywords);
      }

      if (parser.isHive()) {
        keywords = keywords.concat(['ABORT', 'ANALYZE TABLE', 'DELETE', 'EXPORT', 'IMPORT', 'LOAD', 'MERGE', 'MSCK', 'RELOAD FUNCTION', 'RESET']);
      }

      if (parser.isImpala()) {
        keywords = keywords.concat(['COMMENT ON', 'COMPUTE', 'DELETE', 'INVALIDATE METADATA', 'LOAD', 'REFRESH', 'UPSERT']);
      }

      parser.suggestKeywords(keywords);
    };

    parser.checkForSelectListKeywords = function (selectList) {
      if (selectList.length === 0) {
        return;
      }
      var last = selectList[selectList.length - 1];
      if (!last || !last.valueExpression) {
        return;
      }
      var valueExpressionKeywords = parser.getValueExpressionKeywords(last.valueExpression);
      var keywords = [];
      if (last.suggestKeywords) {
        keywords = keywords.concat(last.suggestKeywords);
      }
      if (valueExpressionKeywords.suggestKeywords) {
        keywords = keywords.concat(valueExpressionKeywords.suggestKeywords);
      }
      if (valueExpressionKeywords.suggestColRefKeywords) {
        parser.suggestColRefKeywords(valueExpressionKeywords.suggestColRefKeywords);
        parser.addColRefIfExists(last.valueExpression);
      }
      if (!last.alias) {
        keywords.push('AS');
      }
      if (keywords.length > 0) {
        parser.suggestKeywords(keywords);
      }
    };

    parser.checkForKeywords = function (expression) {
      if (expression) {
        if (expression.suggestKeywords && expression.suggestKeywords.length > 0) {
          parser.suggestKeywords(expression.suggestKeywords);
        }
        if (expression.suggestColRefKeywords) {
          parser.suggestColRefKeywords(expression.suggestColRefKeywords);
          parser.addColRefIfExists(expression);
        }
      }
    };

    parser.createWeightedKeywords = function (keywords, weight) {
      var result = [];
      keywords.forEach(function (keyword) {
        if (typeof keyword.weight !== 'undefined') {
          keyword.weight = weight + (keyword.weight / 10);
          result.push(keyword);
        } else {
          result.push({value: keyword, weight: weight});
        }
      });
      return result;
    };

    parser.suggestKeywords = function (keywords) {
      var weightedKeywords = [];
      if (keywords.length == 0) {
        return;
      }
      keywords.forEach(function (keyword) {
        if (typeof keyword.weight !== 'undefined') {
          weightedKeywords.push(keyword);
        } else {
          weightedKeywords.push({value: keyword, weight: -1})
        }
      });
      weightedKeywords.sort(function (a, b) {
        if (a.weight !== b.weight) {
          return b.weight - a.weight;
        }
        return a.value.localeCompare(b.value);
      });
      parser.yy.result.suggestKeywords = weightedKeywords;
    };

    parser.suggestColRefKeywords = function (colRefKeywords) {
      parser.yy.result.suggestColRefKeywords = colRefKeywords;
    };

    parser.suggestTablesOrColumns = function (identifier) {
      if (typeof parser.yy.latestTablePrimaries == 'undefined') {
        parser.suggestTables({identifierChain: [{name: identifier}]});
        return;
      }
      var tableRef = parser.yy.latestTablePrimaries.filter(function (tablePrimary) {
        return equalIgnoreCase(tablePrimary.alias, identifier);
      });
      if (tableRef.length > 0) {
        parser.suggestColumns({identifierChain: [{name: identifier}]});
      } else {
        parser.suggestTables({identifierChain: [{name: identifier}]});
      }
    };

    parser.suggestFunctions = function (details) {
      parser.yy.result.suggestFunctions = details || {};
    };

    parser.suggestAggregateFunctions = function () {
      var primaries = [];
      var aliases = {};
      parser.yy.latestTablePrimaries.forEach(function (primary) {
        if (typeof primary.alias !== 'undefined') {
          aliases[primary.alias] = true;
        }
        // Drop if the first one refers to a table alias (...FROM tbl t, t.map tm ...)
        if (typeof primary.identifierChain !== 'undefined' && !aliases[primary.identifierChain[0].name] && typeof primary.owner === 'undefined') {
          primaries.push(primary);
        }
      });
      parser.yy.result.suggestAggregateFunctions = {tablePrimaries: primaries};
    };

    parser.suggestAnalyticFunctions = function () {
      parser.yy.result.suggestAnalyticFunctions = true;
    };

    parser.suggestSetOptions = function () {
      parser.yy.result.suggestSetOptions = true;
    };

    parser.suggestIdentifiers = function (identifiers) {
      parser.yy.result.suggestIdentifiers = identifiers;
    };

    parser.suggestColumns = function (details) {
      if (typeof details === 'undefined') {
        details = {identifierChain: []};
      } else if (typeof details.identifierChain === 'undefined') {
        details.identifierChain = [];
      }
      parser.yy.result.suggestColumns = details;
    };

    parser.suggestGroupBys = function (details) {
      parser.yy.result.suggestGroupBys = details || {};
    };

    parser.suggestOrderBys = function (details) {
      parser.yy.result.suggestOrderBys = details || {};
    };

    parser.suggestFilters = function (details) {
      parser.yy.result.suggestFilters = details || {};
    };

    parser.suggestKeyValues = function (details) {
      parser.yy.result.suggestKeyValues = details || {};
    };

    parser.suggestTables = function (details) {
      parser.yy.result.suggestTables = details || {};
    };

    var adjustLocationForCursor = function (location) {
      // columns are 0-based and lines not, so add 1 to cols
      var newLocation = {
        first_line: location.first_line,
        last_line: location.last_line,
        first_column: location.first_column + 1,
        last_column: location.last_column + 1
      };
      if (parser.yy.cursorFound) {
        if (parser.yy.cursorFound.first_line === newLocation.first_line && parser.yy.cursorFound.last_column <= newLocation.first_column) {
          var additionalSpace = parser.yy.partialLengths.left + parser.yy.partialLengths.right;
          additionalSpace -= parser.yy.partialCursor ? 1 : 3; // For some reason the normal cursor eats 3 positions.
          newLocation.first_column = newLocation.first_column + additionalSpace;
          newLocation.last_column = newLocation.last_column + additionalSpace;
        }
      }
      return newLocation;
    };

    parser.addFunctionLocation = function (location, functionName) {
      // Remove trailing '(' from location
      var adjustedLocation = {
        first_line: location.first_line,
        last_line: location.last_line,
        first_column: location.first_column,
        last_column: location.last_column - 1
      };
      parser.yy.locations.push({
        type: 'function',
        location: adjustLocationForCursor(adjustedLocation),
        function: functionName.toLowerCase()
      });
    };

    parser.addStatementLocation = function (location) {
      // Don't report lonely cursor as a statement
      if (location.first_line === location.last_line && Math.abs(location.last_column - location.first_column) === 1) {
        return;
      }
      var adjustedLocation;
      if (parser.yy.cursorFound && parser.yy.cursorFound.last_line === location.last_line &&
        parser.yy.cursorFound.first_column >= location.first_column && parser.yy.cursorFound.last_column <= location.last_column) {
        var additionalSpace = parser.yy.partialLengths.left + parser.yy.partialLengths.right;
        adjustedLocation = {
          first_line: location.first_line,
          last_line: location.last_line,
          first_column: location.first_column + 1,
          last_column: location.last_column + additionalSpace - (parser.yy.partialCursor ? 0 : 2)
        }
      } else {
        adjustedLocation = {
          first_line: location.first_line,
          last_line: location.last_line,
          first_column: location.first_column + 1,
          last_column: location.last_column + 1
        }
      }

      parser.yy.locations.push({
        type: 'statement',
        location: adjustedLocation
      });
    };

    parser.firstDefined = function () {
      for (var i = 0; i + 1 < arguments.length; i += 2) {
        if (arguments[i]) {
          return arguments[i + 1];
        }
      }
    };

    parser.addClauseLocation = function (type, precedingLocation, locationIfPresent, isCursor) {
      var location;
      if (isCursor) {
        if (parser.yy.partialLengths.left === 0 && parser.yy.partialLengths.right === 0) {
          location = {
            type: type,
            missing: true,
            location: adjustLocationForCursor({
              first_line: precedingLocation.last_line,
              first_column: precedingLocation.last_column,
              last_line: precedingLocation.last_line,
              last_column: precedingLocation.last_column
            })
          }
        } else {
          location = {
            type: type,
            missing: false,
            location: {
              first_line: locationIfPresent.last_line,
              first_column: locationIfPresent.last_column - 1,
              last_line: locationIfPresent.last_line,
              last_column: locationIfPresent.last_column - 1 + parser.yy.partialLengths.right + parser.yy.partialLengths.left
            }
          }
        }
      } else {
        location = {
          type: type,
          missing: !locationIfPresent,
          location: adjustLocationForCursor(locationIfPresent || {
            first_line: precedingLocation.last_line,
            first_column: precedingLocation.last_column,
            last_line: precedingLocation.last_line,
            last_column: precedingLocation.last_column
          })
        };
      }
      if (parser.isInSubquery()) {
        location.subquery = true;
      }
      parser.yy.locations.push(location)
    };

    parser.addStatementTypeLocation = function (identifier, location, additionalText) {
      if (!parser.isImpala()) {
        return;
      }
      var loc = {
        type: 'statementType',
        location: adjustLocationForCursor(location),
        identifier: identifier
      };
      if (typeof additionalText !== 'undefined') {
        switch (identifier) {
          case 'ALTER':
            if (/ALTER\s+VIEW/i.test(additionalText)) {
              loc.identifier = 'ALTER VIEW';
            } else {
              loc.identifier = 'ALTER TABLE';
            }
            break;
          case 'COMPUTE':
            loc.identifier = 'COMPUTE STATS';
            break;
          case 'CREATE':
            if (/CREATE\s+VIEW/i.test(additionalText)) {
              loc.identifier = 'CREATE VIEW';
            } else if (/CREATE\s+TABLE/i.test(additionalText)) {
              loc.identifier = 'CREATE TABLE';
            } else if (/CREATE\s+DATABASE/i.test(additionalText)) {
              loc.identifier = 'CREATE DATABASE';
            } else if (/CREATE\s+ROLE/i.test(additionalText)) {
              loc.identifier = 'CREATE ROLE';
            } else if (/CREATE\s+FUNCTION/i.test(additionalText)) {
              loc.identifier = 'CREATE FUNCTION';
            } else {
              loc.identifier = 'CREATE TABLE';
            }
            break;
          case 'DROP':
            if (/DROP\s+VIEW/i.test(additionalText)) {
              loc.identifier = 'DROP VIEW';
            } else if (/DROP\s+TABLE/i.test(additionalText)) {
              loc.identifier = 'DROP TABLE';
            } else if (/DROP\s+DATABASE/i.test(additionalText)) {
              loc.identifier = 'DROP DATABASE';
            } else if (/DROP\s+ROLE/i.test(additionalText)) {
              loc.identifier = 'DROP ROLE';
            } else if (/DROP\s+STATS/i.test(additionalText)) {
              loc.identifier = 'DROP STATS';
            } else if (/DROP\s+FUNCTION/i.test(additionalText)) {
              loc.identifier = 'DROP FUNCTION';
            } else {
              loc.identifier = 'DROP TABLE';
            }
            break;
          case 'INVALIDATE':
            loc.identifier = 'INVALIDATE METADATA';
            break;
          case 'LOAD':
            loc.identifier = 'LOAD DATA';
            break;
          case 'TRUNCATE':
            loc.identifier = 'TRUNCATE TABLE';
            break;
          default:
        }
      }
      parser.yy.locations.push(loc);
    };

    parser.addFileLocation = function (location, path) {
      parser.yy.locations.push({
        type: 'file',
        location: adjustLocationForCursor(location),
        path: path
      });
    };

    parser.addDatabaseLocation = function (location, identifierChain) {
      parser.yy.locations.push({
        type: 'database',
        location: adjustLocationForCursor(location),
        identifierChain: identifierChain
      });
    };

    parser.addTableLocation = function (location, identifierChain) {
      parser.yy.locations.push({
        type: 'table',
        location: adjustLocationForCursor(location),
        identifierChain: identifierChain
      });
    };

    parser.addColumnAliasLocation = function (location, alias, parentLocation) {
      var aliasLocation = {
        type: 'alias',
        source: 'column',
        alias: alias,
        location: adjustLocationForCursor(location),
        parentLocation: adjustLocationForCursor(parentLocation)
      };
      if (parser.yy.locations.length && parser.yy.locations[parser.yy.locations.length - 1].type === 'column') {
        var closestColumn = parser.yy.locations[parser.yy.locations.length - 1];
        if (closestColumn.location.first_line === aliasLocation.parentLocation.first_line &&
          closestColumn.location.last_line === aliasLocation.parentLocation.last_line &&
          closestColumn.location.first_column === aliasLocation.parentLocation.first_column &&
          closestColumn.location.last_column === aliasLocation.parentLocation.last_column) {
          parser.yy.locations[parser.yy.locations.length - 1].alias = alias;
        }
      }
      parser.yy.locations.push(aliasLocation);
    };

    parser.addTableAliasLocation = function (location, alias, identifierChain) {
      parser.yy.locations.push({
        type: 'alias',
        source: 'table',
        alias: alias,
        location: adjustLocationForCursor(location),
        identifierChain: identifierChain
      });
    };

    parser.addSubqueryAliasLocation = function (location, alias) {
      parser.yy.locations.push({
        type: 'alias',
        source: 'subquery',
        alias: alias,
        location: adjustLocationForCursor(location)
      });
    };

    parser.addAsteriskLocation = function (location, identifierChain) {
      parser.yy.locations.push({
        type: 'asterisk',
        location: adjustLocationForCursor(location),
        identifierChain: identifierChain
      });
    };

    parser.addVariableLocation = function (location, value) {
      if (/\$\{[^}]*\}/.test(value)) {
        parser.yy.locations.push({
          type: 'variable',
          location: adjustLocationForCursor(location),
          value: value
        });
      }
    };

    parser.addColumnLocation = function (location, identifierChain) {
      var isVariable = identifierChain.length && /\$\{[^}]*\}/.test(identifierChain[identifierChain.length - 1].name);
      if (isVariable) {
        parser.yy.locations.push({
          type: 'variable',
          location: adjustLocationForCursor(location),
          value: identifierChain[identifierChain.length - 1].name
        });
      } else {
        parser.yy.locations.push({
          type: 'column',
          location: adjustLocationForCursor(location),
          identifierChain: identifierChain,
          qualified: identifierChain.length > 1
        });
      }
    };

    parser.addCteAliasLocation = function (location, alias) {
      parser.yy.locations.push({
        type: 'alias',
        source: 'cte',
        alias: alias,
        location: adjustLocationForCursor(location)
      });
    };

    parser.addUnknownLocation = function (location, identifierChain) {
      var isVariable = identifierChain.length && /\$\{[^}]*\}/.test(identifierChain[identifierChain.length - 1].name);
      var loc;
      if (isVariable) {
        loc = {
          type: 'variable',
          location: adjustLocationForCursor(location),
          value: identifierChain[identifierChain.length - 1].name
        };
      } else {
        loc = {
          type: 'unknown',
          location: adjustLocationForCursor(location),
          identifierChain: identifierChain,
          qualified: identifierChain.length > 1
        };
      }
      parser.yy.locations.push(loc);
      return loc;
    };

    parser.addColRefToVariableIfExists = function (left, right) {
      if (left && left.columnReference && left.columnReference.length && right && right.columnReference && right.columnReference.length && parser.yy.locations.length > 1) {
        var addColRefToVariableLocation = function (variableValue, colRef) {
          // See if colref is actually an alias
          if (colRef.length === 1 && colRef[0].name) {
            parser.yy.locations.some(function (location) {
              if (location.type === 'column' && location.alias === colRef[0].name) {
                colRef = location.identifierChain;
                return true;
              }
            });
          }

          for (var i = parser.yy.locations.length - 1; i > 0; i--) {
            var location = parser.yy.locations[i];
            if (location.type === 'variable' && location.value === variableValue) {
              location.colRef = { identifierChain: colRef };
              break;
            }
          }
        };

        if (/\$\{[^}]*\}/.test(left.columnReference[0].name)) {
          // left is variable
          addColRefToVariableLocation(left.columnReference[0].name, right.columnReference);
        } else if (/\$\{[^}]*\}/.test(right.columnReference[0].name)) {
          // right is variable
          addColRefToVariableLocation(right.columnReference[0].name, left.columnReference);
        }
      }
    };

    parser.suggestDatabases = function (details) {
      parser.yy.result.suggestDatabases = details || {};
    };

    parser.suggestHdfs = function (details) {
      parser.yy.result.suggestHdfs = details || {};
    };

    parser.suggestValues = function (details) {
      parser.yy.result.suggestValues = details || {};
    };

    parser.determineCase = function (text) {
      if (!parser.yy.caseDetermined) {
        parser.yy.lowerCase = text.toLowerCase() === text;
        parser.yy.caseDetermined = true;
      }
    };

    parser.handleQuotedValueWithCursor = function (lexer, yytext, yylloc, quoteChar) {
      if (yytext.indexOf('\u2020') !== -1 || yytext.indexOf('\u2021') !== -1) {
        parser.yy.partialCursor = yytext.indexOf('\u2021') !== -1;
        var cursorIndex = parser.yy.partialCursor ? yytext.indexOf('\u2021') : yytext.indexOf('\u2020');
        parser.yy.cursorFound = {
          first_line: yylloc.first_line,
          last_line: yylloc.last_line,
          first_column: yylloc.first_column + cursorIndex,
          last_column: yylloc.first_column + cursorIndex + 1
        };
        var remainder = yytext.substring(cursorIndex + 1);
        var remainingQuotes = (lexer.upcomingInput().match(new RegExp(quoteChar, 'g')) || []).length;
        if (remainingQuotes > 0 && remainingQuotes & 1 != 0) {
          parser.yy.missingEndQuote = false;
          lexer.input();
        } else {
          parser.yy.missingEndQuote = true;
          lexer.unput(remainder);
        }
        lexer.popState();
        return true;
      }
      return false;
    };

    var lexerModified = false;

    /**
     * Main parser function
     */
    parser.parseSql = function (beforeCursor, afterCursor, dialect, debug) {
      // Jison counts CRLF as two lines in the locations
      beforeCursor = beforeCursor.replace(/\r\n|\n\r/gm, '\n');
      afterCursor = afterCursor.replace(/\r\n|\n\r/gm, '\n');
      parser.yy.result = {locations: []};
      parser.yy.lowerCase = false;
      parser.yy.locations = [];
      parser.yy.allLocations = [];
      parser.yy.subQueries = [];
      parser.yy.errors = [];
      parser.yy.selectListAliases = [];

      parser.yy.locationsStack = [];
      parser.yy.primariesStack = [];
      parser.yy.lateralViewsStack = [];
      parser.yy.subQueriesStack = [];
      parser.yy.resultStack = [];
      parser.yy.selectListAliasesStack = [];

      delete parser.yy.caseDetermined;
      delete parser.yy.cursorFound;
      delete parser.yy.partialCursor;

      parser.prepareNewStatement();

      var REASONABLE_SURROUNDING_LENGTH = 150000; // About 3000 lines before and after

      if (beforeCursor.length > REASONABLE_SURROUNDING_LENGTH) {
        if ((beforeCursor.length - beforeCursor.lastIndexOf(';')) > REASONABLE_SURROUNDING_LENGTH) {
          // Bail out if the last complete statement is more than 150000 chars before
          return {};
        }
        // Cut it at the first statement found within 150000 chars before
        var lastReasonableChunk = beforeCursor.substring(beforeCursor.length - REASONABLE_SURROUNDING_LENGTH);
        beforeCursor = lastReasonableChunk.substring(lastReasonableChunk.indexOf(';') + 1);
      }

      if (afterCursor.length > REASONABLE_SURROUNDING_LENGTH) {
        if ((afterCursor.length - afterCursor.indexOf(';')) > REASONABLE_SURROUNDING_LENGTH) {
          // No need to bail out for what's comes after, we can still get keyword completion
          afterCursor = '';
        } else {
          // Cut it at the last statement found within 150000 chars after
          var firstReasonableChunk = afterCursor.substring(0, REASONABLE_SURROUNDING_LENGTH);
          afterCursor = firstReasonableChunk.substring(0, firstReasonableChunk.lastIndexOf(';'));
        }
      }

      parser.yy.partialLengths = parser.identifyPartials(beforeCursor, afterCursor);

      if (parser.yy.partialLengths.left > 0) {
        beforeCursor = beforeCursor.substring(0, beforeCursor.length - parser.yy.partialLengths.left);
      }

      if (parser.yy.partialLengths.right > 0) {
        afterCursor = afterCursor.substring(parser.yy.partialLengths.right);
      }

      parser.yy.activeDialect = (dialect !== 'hive' && dialect !== 'impala') ? undefined : dialect;

      // Hack to set the inital state of the lexer without first having to hit a token
      // has to be done as the first token found can be dependant on dialect
      if (!lexerModified) {
        var originalSetInput = parser.lexer.setInput;
        parser.lexer.setInput = function (input, yy) {
          var lexer = originalSetInput.bind(parser.lexer)(input, yy);
          if (typeof parser.yy.activeDialect !== 'undefined') {
            lexer.begin(parser.yy.activeDialect);
          }
          return lexer;
        };
        lexerModified = true;
      }

      var result;
      try {
        // Add |CURSOR| or |PARTIAL_CURSOR| to represent the different cursor states in the lexer
        result = parser.parse(beforeCursor + (beforeCursor.length == 0 || /[\s\(]$$/.test(beforeCursor) ? ' \u2020 ' : '\u2021') + afterCursor);
      } catch (err) {
        // On any error try to at least return any existing result
        if (typeof parser.yy.result === 'undefined') {
          throw err;
        }
        if (debug) {
          console.log(err);
          console.error(err.stack);
        }
        result = parser.yy.result;
      }
      if (parser.yy.errors.length > 0) {
        parser.yy.result.errors = parser.yy.errors;
        if (debug) {
          console.log(parser.yy.errors);
        }
      }
      try {
        linkTablePrimaries();
        parser.commitLocations();
        // Clean up and prioritize
        prioritizeSuggestions();
      } catch (err) {
        if (debug) {
          console.log(err);
          console.error(err.stack);
        }
      }


      parser.yy.allLocations.sort(function (a, b) {
        if (a.location.first_line !== b.location.first_line) {
          return a.location.first_line - b.location.first_line;
        }
        if (a.location.first_column !== b.location.first_column) {
          return a.location.first_column - b.location.first_column;
        }
        if (a.location.last_column !== b.location.last_column) {
          return b.location.last_column - a.location.last_column;
        }
        return b.type.localeCompare(a.type);
      });
      parser.yy.result.locations = parser.yy.allLocations;

      parser.yy.result.locations.forEach(function (location) {
        delete location.linked;
      });
      if (typeof parser.yy.result.suggestColumns !== 'undefined') {
        delete parser.yy.result.suggestColumns.linked;
      }

      SIMPLE_TABLE_REF_SUGGESTIONS.forEach(function (suggestionType) {
        if (typeof parser.yy.result[suggestionType] !== 'undefined') {
          delete parser.yy.result[suggestionType].linked;
        }
      });

      if (typeof parser.yy.result.colRef !== 'undefined') {
        delete parser.yy.result.colRef.linked;
      }
      if (typeof parser.yy.result.suggestKeyValues !== 'undefined') {
        delete parser.yy.result.suggestKeyValues.linked;
      }

      if (typeof result.error !== 'undefined' && typeof result.error.expected !== 'undefined') {
        // Remove any expected tokens from other dialects, jison doesn't remove tokens from other lexer states.
        var actualExpected = {};
        result.error.expected.forEach(function (expected) {
          var match = expected.match(/\<([a-z]+)\>(.*)/);
          if (match !== null) {
            if (typeof parser.yy.activeDialect !== 'undefined' && parser.yy.activeDialect === match[1]) {
              actualExpected[("'" + match[2])] = true;
            }
          } else if (expected.indexOf('CURSOR') == -1) {
            actualExpected[expected] = true;
          }
        });
        result.error.expected = Object.keys(actualExpected);
      }

      if (typeof result.error !== 'undefined' && result.error.recoverable) {
        delete result.error;
      }

      // Adjust all the statement locations to include white space surrounding them
      var lastStatementLocation = null;
      result.locations.forEach(function (location) {
        if (location.type === 'statement') {
          if (lastStatementLocation === null) {
            location.location.first_line = 1;
            location.location.first_column = 1;
          } else {
            location.location.first_line = lastStatementLocation.location.last_line;
            location.location.first_column = lastStatementLocation.location.last_column + 1;
          }
          lastStatementLocation = location;
        }
      });

      return result;
    };
  };

  var SYNTAX_PARSER_NOOP_FUNCTIONS = ['prepareNewStatement', 'addCommonTableExpressions', 'pushQueryState', 'popQueryState', 'suggestSelectListAliases',
    'suggestValueExpressionKeywords', 'getSelectListKeywords', 'getValueExpressionKeywords', 'addColRefIfExists', 'selectListNoTableSuggest', 'suggestJoinConditions',
    'suggestJoins', 'valueExpressionSuggest', 'applyTypeToSuggestions', 'applyArgumentTypesToSuggestions', 'commitLocations', 'identifyPartials',
    'getSubQuery', 'addTablePrimary', 'suggestFileFormats', 'suggestDdlAndDmlKeywords', 'checkForSelectListKeywords', 'checkForKeywords',
    'suggestKeywords', 'suggestColRefKeywords', 'suggestTablesOrColumns', 'suggestFunctions', 'suggestAggregateFunctions', 'suggestAnalyticFunctions',
    'suggestColumns', 'suggestGroupBys', 'suggestIdentifiers', 'suggestOrderBys', 'suggestFilters', 'suggestKeyValues', 'suggestTables', 'addFunctionLocation',
    'addStatementLocation', 'firstDefined', 'addClauseLocation', 'addStatementTypeLocation', 'addFileLocation', 'addDatabaseLocation', 'addColumnAliasLocation',
    'addTableAliasLocation', 'addSubqueryAliasLocation', 'addTableLocation', 'addAsteriskLocation', 'addVariableLocation', 'addColumnLocation', 'addCteAliasLocation',
    'addUnknownLocation', 'addColRefToVariableIfExists', 'suggestDatabases', 'suggestHdfs', 'suggestValues'];

  var SYNTAX_PARSER_NOOP = function () {};

  var initSyntaxParser = function (parser) {

    // Noop functions for compatibility with the autocomplete parser as the grammar is shared
    SYNTAX_PARSER_NOOP_FUNCTIONS.forEach(function (noopFn) {
      parser[noopFn] = SYNTAX_PARSER_NOOP
    });

    parser.yy.locations = [{}];

    parser.determineCase = function (text) {
      if (!parser.yy.caseDetermined) {
        parser.yy.lowerCase = text.toLowerCase() === text;
        parser.yy.caseDetermined = true;
      }
    };

    parser.getKeywordsForOptionalsLR = function () {
      return [];
    };

    parser.mergeSuggestKeywords = function () {
      return {};
    };

    parser.getTypeKeywords = function () {
      return [];
    };

    parser.getColumnDataTypeKeywords = function () {
      return [];
    };

    parser.findCaseType = function () {
      return {types: ['T']};
    };

    parser.findReturnTypes = function (functionName) {
      return ['T'];
    };

    parser.isHive = function () {
      return parser.yy.activeDialect === 'hive';
    };

    parser.isImpala = function () {
      return parser.yy.activeDialect === 'impala';
    };

    parser.expandImpalaIdentifierChain = function () {
      return [];
    };

    parser.expandIdentifierChain = function () {
      return [];
    };

    parser.expandLateralViews = function () {
      return [];
    };

    parser.createWeightedKeywords = function () {
      return [];
    };

    parser.handleQuotedValueWithCursor = function (lexer, yytext, yylloc, quoteChar) {
      if (yytext.indexOf('\u2020') !== -1 || yytext.indexOf('\u2021') !== -1) {
        parser.yy.partialCursor = yytext.indexOf('\u2021') !== -1;
        var cursorIndex = parser.yy.partialCursor ? yytext.indexOf('\u2021') : yytext.indexOf('\u2020');
        parser.yy.cursorFound = {
          first_line: yylloc.first_line,
          last_line: yylloc.last_line,
          first_column: yylloc.first_column + cursorIndex,
          last_column: yylloc.first_column + cursorIndex + 1
        };
        var remainder = yytext.substring(cursorIndex + 1);
        var remainingQuotes = (lexer.upcomingInput().match(new RegExp(quoteChar, 'g')) || []).length;
        if (remainingQuotes > 0 && remainingQuotes & 1 != 0) {
          parser.yy.missingEndQuote = false;
          lexer.input();
        } else {
          parser.yy.missingEndQuote = true;
          lexer.unput(remainder);
        }
        lexer.popState();
        return true;
      }
      return false;
    };

    var lexerModified = false;

    parser.yy.parseError = function (str, hash) {
      parser.yy.error = hash;
    };

    var IGNORED_EXPECTED = {
      ';': true,
      '.': true,
      'EOF': true,
      'UNSIGNED_INTEGER': true,
      'UNSIGNED_INTEGER_E': true,
      'REGULAR_IDENTIFIER': true, // TODO: Indicate that an identifier was expected
      'CURSOR': true,
      'PARTIAL_CURSOR': true,
      'HDFS_START_QUOTE': true,
      'HDFS_PATH': true,
      'HDFS_END_QUOTE' : true,
      'COMPARISON_OPERATOR': true, // TODO: Expand in results when found
      'ARITHMETIC_OPERATOR' : true, // TODO: Expand in results when found
      'VARIABLE_REFERENCE': true,
      'BACKTICK': true,
      'VALUE': true,
      'PARTIAL_VALUE': true,
      'SINGLE_QUOTE': true,
      'DOUBLE_QUOTE': true
    };

    var CLEAN_EXPECTED = {
      'BETWEEN_AND': 'AND',
      'OVERWRITE_DIRECTORY' : 'OVERWRITE',
      'STORED_AS_DIRECTORIES' : 'STORED',
      'LIKE_PARQUET' : 'LIKE',
      'PARTITION_VALUE' : 'PARTITION'
    };

    parser.parseSyntax = function (beforeCursor, afterCursor, dialect, debug) {
      parser.yy.caseDetermined = false;
      parser.yy.error = undefined;

      parser.yy.latestTablePrimaries = [];
      parser.yy.subQueries = [];
      parser.yy.selectListAliases = [];
      parser.yy.latestTablePrimaries = [];

      parser.yy.activeDialect = (dialect !== 'hive' && dialect !== 'impala') ? undefined : dialect;

      // Hack to set the inital state of the lexer without first having to hit a token
      // has to be done as the first token found can be dependant on dialect
      if (!lexerModified) {
        var originalSetInput = parser.lexer.setInput;
        parser.lexer.setInput = function (input, yy) {
          var lexer = originalSetInput.bind(parser.lexer)(input, yy);
          if (typeof parser.yy.activeDialect !== 'undefined') {
            lexer.begin(parser.yy.activeDialect);
          }
          return lexer;
        };
        lexerModified = true;
      }

      // TODO: Find a way around throwing an exception when the parser finds a syntax error
      try {
        parser.yy.error = false;
        parser.parse(beforeCursor + afterCursor);
      } catch (err) {
        if (debug) {
          console.log(err);
          console.error(err.stack);
          console.log(parser.yy.error);
        }
      }

      if (parser.yy.error && (parser.yy.error.loc.last_column < beforeCursor.length || !beforeCursor.endsWith(parser.yy.error.text))) {
        var weightedExpected = [];

        var addedExpected = {};

        var isLowerCase = parser.yy.caseDetermined && parser.yy.lowerCase || parser.yy.error.text.toLowerCase() === parser.yy.error.text;

        if (parser.yy.error.expected.length == 2 && parser.yy.error.expected.indexOf('\';\'') !== -1 && parser.yy.error.expected.indexOf('\'EOF\'') !== -1) {
          parser.yy.error.expected = [];
          parser.yy.error.expectedStatementEnd = true;
          return parser.yy.error;
        }
        for (var i = 0; i < parser.yy.error.expected.length; i++) {
          var expected = parser.yy.error.expected[i];
          // Strip away the surrounding ' chars
          expected = expected.substring(1, expected.length - 1);
          // TODO: Only suggest alphanumeric?
          if (!IGNORED_EXPECTED[expected] && /[a-z_]+/i.test(expected)) {
            if (dialect && expected.indexOf('<' + dialect + '>') == 0) {
              expected = expected.substring(dialect.length + 2);
            } else if (/^<[a-z]+>/.test(expected)) {
              continue;
            }
            expected = CLEAN_EXPECTED[expected] || expected;
            if (expected === parser.yy.error.text.toUpperCase()) {
              // Can happen when the lexer entry for a rule contains multiple words like 'stored' in 'stored as parquet'
              return false;
            }
            var text = isLowerCase ? expected.toLowerCase() : expected;
            if (text && !addedExpected[text]) {
              addedExpected[text] = true;
              weightedExpected.push({
                text: text,
                distance: stringDistance(parser.yy.error.text, text, true)
              });
            }
          }
        }
        if (weightedExpected.length === 0) {
          parser.yy.error.expected = [];
          parser.yy.error.incompleteStatement = true;
          return parser.yy.error;
        }
        weightedExpected.sort(function (a, b) {
          if (a.distance === b.distance) {
            return a.text.localeCompare(b.text);
          }
          return a.distance - b.distance
        });
        parser.yy.error.expected = weightedExpected;
        parser.yy.error.incompleteStatement = true;
        return parser.yy.error;
      } else if (parser.yy.error) {
        parser.yy.error.expected = [];
        parser.yy.error.incompleteStatement = true;
        return parser.yy.error;
      }
      return false;
    }
  };

  var initGlobalSearchParser = function (parser) {

    parser.identifyPartials = function (beforeCursor, afterCursor) {
      var beforeMatch = beforeCursor.match(/[0-9a-zA-Z_]*$/);
      var afterMatch = afterCursor.match(/^[0-9a-zA-Z_]*(?:\((?:[^)]*\))?)?/);
      return {left: beforeMatch ? beforeMatch[0].length : 0, right: afterMatch ? afterMatch[0].length : 0};
    };

    parser.mergeFacets = function (a, b) {
      if (!a.facets) {
        a.facets = {};
      }
      if (!b.facets) {
        return;
      }
      Object.keys(b.facets).forEach(function (key) {
        if (a.facets[key]) {
          Object.keys(b.facets[key]).forEach(function (val) {
            a.facets[key][val.toLowerCase()] = true;
          });
        } else {
          a.facets[key] = b.facets[key];
        }
      });
    };

    parser.mergeText = function (a, b) {
      if (!a.text) {
        a.text = [];
      }
      if (!b.text) {
        return;
      }
      a.text = a.text.concat(b.text);
    };

    parser.handleQuotedValueWithCursor = function (lexer, yytext, yylloc, quoteChar) {
      if (yytext.indexOf('\u2020') !== -1 || yytext.indexOf('\u2021') !== -1) {
        var cursorIndex = yytext.indexOf('\u2020');
        parser.yy.cursorFound = {
          first_line: yylloc.first_line,
          last_line: yylloc.last_line,
          first_column: yylloc.first_column + cursorIndex,
          last_column: yylloc.first_column + cursorIndex + 1
        };
        var remainder = yytext.substring(cursorIndex + 1);
        var remainingQuotes = (lexer.upcomingInput().match(new RegExp(quoteChar, 'g')) || []).length;
        if (remainingQuotes > 0 && remainingQuotes & 1 != 0) {
          parser.yy.missingEndQuote = false;
          lexer.input();
        } else {
          parser.yy.missingEndQuote = true;
          lexer.unput(remainder);
        }
        lexer.popState();
        return true;
      }
      return false;
    };

    parser.parseGlobalSearch = function (beforeCursor, afterCursor, debug) {
      delete parser.yy.cursorFound;

      var result;
      try {
        result = parser.parse(beforeCursor + '\u2020' + afterCursor);
      } catch (err) {
        if (debug) {
          console.log(err);
          console.error(err.stack);
          console.log(parser.yy.error);
        }
        return {
          facets: {},
          text: []
        }
      }
      return result;
    };
  };

  return {
    initSqlParser: initSqlParser,
    initSyntaxParser: initSyntaxParser,
    stringDistance: stringDistance,
    initGlobalSearchParser: initGlobalSearchParser
  };
})();
/* parser generated by jison 0.4.18 */
/*
  Returns a Parser object of the following structure:

  Parser: {
    yy: {}
  }

  Parser.prototype: {
    yy: {},
    trace: function(),
    symbols_: {associative list: name ==> number},
    terminals_: {associative list: number ==> name},
    productions_: [...],
    performAction: function anonymous(yytext, yyleng, yylineno, yy, yystate, $$, _$),
    table: [...],
    defaultActions: {...},
    parseError: function(str, hash),
    parse: function(input),

    lexer: {
        EOF: 1,
        parseError: function(str, hash),
        setInput: function(input),
        input: function(),
        unput: function(str),
        more: function(),
        less: function(n),
        pastInput: function(),
        upcomingInput: function(),
        showPosition: function(),
        test_match: function(regex_match_array, rule_index),
        next: function(),
        lex: function(),
        begin: function(condition),
        popState: function(),
        _currentRules: function(),
        topState: function(),
        pushState: function(condition),

        options: {
            ranges: boolean           (optional: true ==> token location info will include a .range[] member)
            flex: boolean             (optional: true ==> flex-like lexing behaviour where the rules are tested exhaustively to find the longest match)
            backtrack_lexer: boolean  (optional: true ==> lexer regexes are tested in order and for each matching regex the action code is invoked; the lexer terminates the scan when a token is returned by the action code)
        },

        performAction: function(yy, yy_, $avoiding_name_collisions, YY_START),
        rules: [...],
        conditions: {associative list: name ==> set},
    }
  }


  token location info (@$, _$, etc.): {
    first_line: n,
    last_line: n,
    first_column: n,
    last_column: n,
    range: [start_number, end_number]       (where the numbers are indexes into the input string, regular zero-based)
  }


  the parseError function receives a 'hash' object with these members for lexer and parser errors: {
    text:        (matched text)
    token:       (the produced terminal token, if any)
    line:        (yylineno)
  }
  while parser (grammar) errors will also provide these members, i.e. parser errors deliver a superset of attributes: {
    loc:         (yylloc)
    expected:    (string describing the set of expected tokens)
    recoverable: (boolean: TRUE when the parser has a error recovery rule available for this particular error)
  }
*/
var sqlAutocompleteParser = (function(){
var o=function(k,v,o,l){for(o=o||{},l=k.length;l--;o[k[l]]=v);return o},$V0=[2,6,10,19,24,26,28,30,32,33,34,37,38,39,40,42,43,45,46,47,48,49,50,51,52,54,56,58,59,60,61,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,85,86,87,88,89,90,91,92,93,95,96,97,98,99,100,101,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,128,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,156,157,158,160,161,163,164,165,166,167,168,169,170,171,172,173,174,175,176,177,178,179,180,181,182,183,184,185,186,187,188,189,190,191,192,193,194,195,196,197,198,199,200,201,202,203,204,205,206,207,208,209,210,211,212,213,214,215,216,217,218,219,220,221,222,223,224,225,226,227,228,229,230,231,232,233,234,235,236,237,238,239,240,241,242,243,244,245,246,247,248,249,250,251,252,253,254,255,256,257,258,259,260,261,262,263,264,265,266,267,268,269,270,271,272,273,274,275,276,277,278,279,280,281,282,283,284,285,286,287,288,289,290,291,292,293,294,295,296,297,298,299,300,301,302,303,304,305,306,307,308,309,310,311,312,313,314,315,316,317,318,319,320,321,322,323,324,325,326,327,328,329,330,331,332,333,334,335,336,337,338,339,340,341,342,343,344,345,346,347,348,349,350,351,352,353,354,355,356,357,358,359,360,361,362,363,364,365,366,367,368,369,370,371,372,373,374,375,376,377,378,379,380,381,382,383,384,385,386,387,388,389,390,391,392,393,394,395,396,397,398,399,400,401,402,403,404,438,439,440,441,452,569,570,571,577,763,826,868,930,931,933,1166,1190,1191,1192,1193,1195,1213,1227,1252,1253,1278,1314],$V1=[2,4],$V2=[6,10],$V3=[2,5],$V4=[1,6],$V5=[1,385],$V6=[1,359],$V7=[1,442],$V8=[1,13],$V9=[1,422],$Va=[1,17],$Vb=[1,19],$Vc=[1,20],$Vd=[1,23],$Ve=[1,24],$Vf=[1,78],$Vg=[1,79],$Vh=[1,80],$Vi=[1,25],$Vj=[1,81],$Vk=[1,82],$Vl=[1,30],$Vm=[1,32],$Vn=[1,83],$Vo=[1,33],$Vp=[1,34],$Vq=[1,35],$Vr=[1,38],$Vs=[1,39],$Vt=[1,383],$Vu=[1,473],$Vv=[1,42],$Vw=[1,43],$Vx=[1,46],$Vy=[1,85],$Vz=[1,88],$VA=[1,89],$VB=[1,91],$VC=[1,50],$VD=[1,90],$VE=[1,51],$VF=[1,92],$VG=[1,93],$VH=[1,545],$VI=[1,94],$VJ=[1,95],$VK=[1,56],$VL=[1,96],$VM=[1,562],$VN=[1,531],$VO=[1,98],$VP=[1,58],$VQ=[1,100],$VR=[1,102],$VS=[1,59],$VT=[1,60],$VU=[1,103],$VV=[1,104],$VW=[1,105],$VX=[1,62],$VY=[1,63],$VZ=[1,106],$V_=[1,65],$V$=[1,532],$V01=[1,67],$V11=[1,57],$V21=[1,68],$V31=[1,69],$V41=[1,107],$V51=[1,108],$V61=[1,110],$V71=[1,111],$V81=[1,112],$V91=[1,113],$Va1=[1,71],$Vb1=[1,559],$Vc1=[1,114],$Vd1=[1,115],$Ve1=[1,72],$Vf1=[1,116],$Vg1=[1,118],$Vh1=[1,278],$Vi1=[1,119],$Vj1=[1,121],$Vk1=[1,122],$Vl1=[1,123],$Vm1=[1,124],$Vn1=[1,75],$Vo1=[1,125],$Vp1=[1,126],$Vq1=[1,127],$Vr1=[1,542],$Vs1=[1,76],$Vt1=[1,129],$Vu1=[1,131],$Vv1=[1,307],$Vw1=[1,310],$Vx1=[1,311],$Vy1=[1,312],$Vz1=[1,316],$VA1=[1,317],$VB1=[1,318],$VC1=[1,319],$VD1=[1,196],$VE1=[1,198],$VF1=[1,199],$VG1=[1,179],$VH1=[1,204],$VI1=[1,205],$VJ1=[1,194],$VK1=[1,186],$VL1=[1,166],$VM1=[1,290],$VN1=[1,260],$VO1=[1,330],$VP1=[1,349],$VQ1=[1,384],$VR1=[1,16],$VS1=[1,40],$VT1=[1,14],$VU1=[1,15],$VV1=[1,18],$VW1=[1,21],$VX1=[1,22],$VY1=[1,26],$VZ1=[1,27],$V_1=[1,28],$V$1=[1,29],$V02=[1,31],$V12=[1,36],$V22=[1,37],$V32=[1,41],$V42=[1,44],$V52=[1,45],$V62=[1,47],$V72=[1,48],$V82=[1,49],$V92=[1,52],$Va2=[1,53],$Vb2=[1,54],$Vc2=[1,55],$Vd2=[1,61],$Ve2=[1,64],$Vf2=[1,66],$Vg2=[1,70],$Vh2=[1,73],$Vi2=[1,74],$Vj2=[1,77],$Vk2=[1,84],$Vl2=[1,86],$Vm2=[1,87],$Vn2=[1,97],$Vo2=[1,99],$Vp2=[1,101],$Vq2=[1,109],$Vr2=[1,117],$Vs2=[1,120],$Vt2=[1,128],$Vu2=[1,130],$Vv2=[1,132],$Vw2=[1,133],$Vx2=[1,134],$Vy2=[1,135],$Vz2=[1,136],$VA2=[1,137],$VB2=[1,138],$VC2=[1,139],$VD2=[1,140],$VE2=[1,141],$VF2=[1,142],$VG2=[1,143],$VH2=[1,144],$VI2=[1,145],$VJ2=[1,146],$VK2=[1,147],$VL2=[1,148],$VM2=[1,149],$VN2=[1,150],$VO2=[1,151],$VP2=[1,152],$VQ2=[1,153],$VR2=[1,154],$VS2=[1,155],$VT2=[1,156],$VU2=[1,157],$VV2=[1,158],$VW2=[1,159],$VX2=[1,160],$VY2=[1,161],$VZ2=[1,162],$V_2=[1,163],$V$2=[1,164],$V03=[1,165],$V13=[1,167],$V23=[1,168],$V33=[1,169],$V43=[1,170],$V53=[1,171],$V63=[1,172],$V73=[1,173],$V83=[1,174],$V93=[1,175],$Va3=[1,176],$Vb3=[1,177],$Vc3=[1,178],$Vd3=[1,180],$Ve3=[1,181],$Vf3=[1,182],$Vg3=[1,183],$Vh3=[1,184],$Vi3=[1,185],$Vj3=[1,187],$Vk3=[1,188],$Vl3=[1,189],$Vm3=[1,190],$Vn3=[1,191],$Vo3=[1,192],$Vp3=[1,193],$Vq3=[1,195],$Vr3=[1,197],$Vs3=[1,200],$Vt3=[1,201],$Vu3=[1,202],$Vv3=[1,203],$Vw3=[1,206],$Vx3=[1,207],$Vy3=[1,208],$Vz3=[1,209],$VA3=[1,210],$VB3=[1,211],$VC3=[1,212],$VD3=[1,213],$VE3=[1,214],$VF3=[1,215],$VG3=[1,216],$VH3=[1,217],$VI3=[1,218],$VJ3=[1,219],$VK3=[1,220],$VL3=[1,221],$VM3=[1,222],$VN3=[1,223],$VO3=[1,224],$VP3=[1,225],$VQ3=[1,226],$VR3=[1,227],$VS3=[1,228],$VT3=[1,229],$VU3=[1,230],$VV3=[1,231],$VW3=[1,232],$VX3=[1,233],$VY3=[1,234],$VZ3=[1,235],$V_3=[1,236],$V$3=[1,237],$V04=[1,238],$V14=[1,239],$V24=[1,240],$V34=[1,241],$V44=[1,242],$V54=[1,243],$V64=[1,244],$V74=[1,245],$V84=[1,246],$V94=[1,247],$Va4=[1,248],$Vb4=[1,249],$Vc4=[1,250],$Vd4=[1,251],$Ve4=[1,252],$Vf4=[1,253],$Vg4=[1,254],$Vh4=[1,255],$Vi4=[1,256],$Vj4=[1,257],$Vk4=[1,258],$Vl4=[1,259],$Vm4=[1,261],$Vn4=[1,262],$Vo4=[1,263],$Vp4=[1,264],$Vq4=[1,265],$Vr4=[1,266],$Vs4=[1,267],$Vt4=[1,268],$Vu4=[1,269],$Vv4=[1,270],$Vw4=[1,271],$Vx4=[1,272],$Vy4=[1,273],$Vz4=[1,274],$VA4=[1,275],$VB4=[1,276],$VC4=[1,277],$VD4=[1,279],$VE4=[1,280],$VF4=[1,281],$VG4=[1,282],$VH4=[1,283],$VI4=[1,284],$VJ4=[1,285],$VK4=[1,286],$VL4=[1,287],$VM4=[1,288],$VN4=[1,289],$VO4=[1,291],$VP4=[1,292],$VQ4=[1,293],$VR4=[1,294],$VS4=[1,295],$VT4=[1,296],$VU4=[1,297],$VV4=[1,298],$VW4=[1,299],$VX4=[1,300],$VY4=[1,301],$VZ4=[1,302],$V_4=[1,303],$V$4=[1,304],$V05=[1,305],$V15=[1,306],$V25=[1,308],$V35=[1,309],$V45=[1,313],$V55=[1,314],$V65=[1,315],$V75=[1,320],$V85=[1,321],$V95=[1,322],$Va5=[1,323],$Vb5=[1,324],$Vc5=[1,325],$Vd5=[1,326],$Ve5=[1,327],$Vf5=[1,328],$Vg5=[1,329],$Vh5=[1,331],$Vi5=[1,332],$Vj5=[1,333],$Vk5=[1,334],$Vl5=[1,335],$Vm5=[1,336],$Vn5=[1,337],$Vo5=[1,338],$Vp5=[1,339],$Vq5=[1,340],$Vr5=[1,341],$Vs5=[1,342],$Vt5=[1,343],$Vu5=[1,344],$Vv5=[1,345],$Vw5=[1,346],$Vx5=[1,347],$Vy5=[1,348],$Vz5=[1,350],$VA5=[1,351],$VB5=[1,352],$VC5=[1,553],$VD5=[1,554],$VE5=[1,555],$VF5=[1,386],$VG5=[1,533],$VH5=[1,528],$VI5=[1,563],$VJ5=[1,564],$VK5=[1,475],$VL5=[1,540],$VM5=[1,485],$VN5=[1,501],$VO5=[1,423],$VP5=[1,424],$VQ5=[1,425],$VR5=[1,466],$VS5=[1,543],$VT5=[1,474],$VU5=[1,570],$VV5=[1,443],$VW5=[1,444],$VX5=[1,523],$VY5=[1,569],$VZ5=[1,546],$V_5=[1,472],$V$5=[1,558],$V06=[1,541],$V16=[1,588],$V26=[1,587],$V36=[2,213],$V46=[1,592],$V56=[1,614],$V66=[1,615],$V76=[1,616],$V86=[1,617],$V96=[1,618],$Va6=[1,619],$Vb6=[1,620],$Vc6=[1,621],$Vd6=[1,622],$Ve6=[1,623],$Vf6=[1,624],$Vg6=[1,625],$Vh6=[1,626],$Vi6=[1,627],$Vj6=[1,628],$Vk6=[1,629],$Vl6=[1,630],$Vm6=[1,631],$Vn6=[1,632],$Vo6=[1,633],$Vp6=[1,634],$Vq6=[1,635],$Vr6=[1,636],$Vs6=[1,637],$Vt6=[1,638],$Vu6=[1,639],$Vv6=[1,640],$Vw6=[1,641],$Vx6=[1,642],$Vy6=[1,643],$Vz6=[1,644],$VA6=[1,645],$VB6=[1,646],$VC6=[1,647],$VD6=[1,648],$VE6=[1,649],$VF6=[1,650],$VG6=[1,651],$VH6=[1,652],$VI6=[1,653],$VJ6=[1,654],$VK6=[1,655],$VL6=[1,656],$VM6=[1,657],$VN6=[1,658],$VO6=[1,659],$VP6=[1,660],$VQ6=[1,661],$VR6=[1,662],$VS6=[1,663],$VT6=[1,664],$VU6=[1,665],$VV6=[1,666],$VW6=[1,667],$VX6=[1,668],$VY6=[1,669],$VZ6=[1,670],$V_6=[1,671],$V$6=[1,672],$V07=[1,673],$V17=[1,674],$V27=[1,675],$V37=[1,676],$V47=[1,677],$V57=[1,678],$V67=[1,679],$V77=[1,680],$V87=[1,681],$V97=[1,682],$Va7=[1,683],$Vb7=[1,684],$Vc7=[1,685],$Vd7=[1,686],$Ve7=[1,687],$Vf7=[1,688],$Vg7=[1,689],$Vh7=[1,690],$Vi7=[1,691],$Vj7=[1,692],$Vk7=[1,693],$Vl7=[1,591],$Vm7=[1,694],$Vn7=[1,695],$Vo7=[1,696],$Vp7=[1,697],$Vq7=[1,698],$Vr7=[1,699],$Vs7=[1,700],$Vt7=[1,701],$Vu7=[1,702],$Vv7=[1,703],$Vw7=[1,704],$Vx7=[1,705],$Vy7=[1,706],$Vz7=[1,707],$VA7=[1,708],$VB7=[1,709],$VC7=[1,710],$VD7=[1,711],$VE7=[1,712],$VF7=[1,713],$VG7=[1,714],$VH7=[1,715],$VI7=[1,716],$VJ7=[1,717],$VK7=[1,718],$VL7=[1,719],$VM7=[1,720],$VN7=[1,721],$VO7=[1,722],$VP7=[1,723],$VQ7=[1,724],$VR7=[1,725],$VS7=[1,726],$VT7=[1,727],$VU7=[1,728],$VV7=[1,729],$VW7=[1,730],$VX7=[1,731],$VY7=[1,732],$VZ7=[1,733],$V_7=[1,734],$V$7=[1,735],$V08=[1,736],$V18=[1,737],$V28=[1,738],$V38=[1,739],$V48=[1,740],$V58=[1,741],$V68=[1,742],$V78=[1,743],$V88=[1,744],$V98=[1,745],$Va8=[1,611],$Vb8=[1,612],$Vc8=[1,610],$Vd8=[1,608],$Ve8=[1,609],$Vf8=[1,607],$Vg8=[1,599],$Vh8=[1,605],$Vi8=[1,601],$Vj8=[1,604],$Vk8=[1,606],$Vl8=[1,603],$Vm8=[1,600],$Vn8=[1,602],$Vo8=[19,307],$Vp8=[2,2790],$Vq8=[2,309],$Vr8=[1,768],$Vs8=[1,765],$Vt8=[1,767],$Vu8=[2,364],$Vv8=[1,771],$Vw8=[1,769],$Vx8=[1,773],$Vy8=[1,775],$Vz8=[1,779],$VA8=[1,774],$VB8=[1,776],$VC8=[1,778],$VD8=[1,777],$VE8=[2,389],$VF8=[2,399],$VG8=[2,407],$VH8=[1,781],$VI8=[2,440],$VJ8=[1,785],$VK8=[1,786],$VL8=[1,788],$VM8=[2,454],$VN8=[1,798],$VO8=[1,804],$VP8=[1,814],$VQ8=[1,810],$VR8=[1,825],$VS8=[1,848],$VT8=[1,834],$VU8=[1,835],$VV8=[1,816],$VW8=[1,815],$VX8=[1,822],$VY8=[1,846],$VZ8=[1,819],$V_8=[1,828],$V$8=[1,836],$V09=[1,830],$V19=[1,827],$V29=[1,839],$V39=[1,831],$V49=[1,838],$V59=[1,811],$V69=[1,812],$V79=[1,813],$V89=[1,821],$V99=[1,843],$Va9=[1,826],$Vb9=[1,850],$Vc9=[1,817],$Vd9=[1,818],$Ve9=[1,844],$Vf9=[1,849],$Vg9=[1,824],$Vh9=[6,10,399,957],$Vi9=[2,871],$Vj9=[1,857],$Vk9=[19,26,30,59,74,79,80,97,113,131,145,182,218,307,339,352,438,439,440,452,569,570,571,577,763,826,868,930,931,933,1166,1190,1191,1192,1193,1195,1213,1227,1252,1253,1278,1314],$Vl9=[2,174],$Vm9=[1,860],$Vn9=[1,859],$Vo9=[1,861],$Vp9=[26,30,59,74,79,80,97,113,131,145,182,218,307,339,352,438,439,440,452,569,570,571,577,763,826,868,930,931,933,1166,1190,1191,1192,1193,1195,1213,1227,1252,1253,1278,1314],$Vq9=[2,171],$Vr9=[2,557],$Vs9=[2,864],$Vt9=[1,865],$Vu9=[1,867],$Vv9=[2,6,10,399],$Vw9=[1,870],$Vx9=[1,882],$Vy9=[1,902],$Vz9=[1,903],$VA9=[2,3154],$VB9=[2,908],$VC9=[1,924],$VD9=[1,925],$VE9=[1,926],$VF9=[1,938],$VG9=[1,936],$VH9=[1,934],$VI9=[1,937],$VJ9=[1,932],$VK9=[1,933],$VL9=[1,935],$VM9=[1,939],$VN9=[19,178,193,222,262,342],$VO9=[2,653],$VP9=[1,949],$VQ9=[1,950],$VR9=[1,951],$VS9=[1,967],$VT9=[1,998],$VU9=[1,975],$VV9=[1,987],$VW9=[1,999],$VX9=[1,1003],$VY9=[1,991],$VZ9=[1,1006],$V_9=[1,986],$V$9=[1,968],$V0a=[1,1007],$V1a=[1,1008],$V2a=[1,1005],$V3a=[1,973],$V4a=[2,623],$V5a=[1,1000],$V6a=[1,1004],$V7a=[1,996],$V8a=[1,997],$V9a=[1,1022],$Vaa=[1,1028],$Vba=[19,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,160,161,402],$Vca=[2,627],$Vda=[1,1037],$Vea=[1,1038],$Vfa=[2,633],$Vga=[1,1041],$Vha=[1,1042],$Via=[1,1058],$Vja=[1,1084],$Vka=[1,1089],$Vla=[1,1082],$Vma=[1,1073],$Vna=[1,1072],$Voa=[1,1088],$Vpa=[1,1087],$Vqa=[1,1061],$Vra=[1,1077],$Vsa=[1,1085],$Vta=[1,1092],$Vua=[1,1091],$Vva=[1,1078],$Vwa=[1,1090],$Vxa=[1,1059],$Vya=[1,1060],$Vza=[1,1098],$VAa=[1,1097],$VBa=[1,1101],$VCa=[19,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,160,161],$VDa=[1,1109],$VEa=[1,1110],$VFa=[19,45,216],$VGa=[1,1129],$VHa=[1,1126],$VIa=[1,1130],$VJa=[1,1119],$VKa=[1,1118],$VLa=[1,1120],$VMa=[1,1122],$VNa=[1,1123],$VOa=[1,1124],$VPa=[1,1125],$VQa=[19,106,122,133,147,157,178,181,193,196,201,210,222,229,262,296,337,342,1101],$VRa=[19,39,42,46,65,76,91,106,107,108,120,121,128,143,144,145,147,148,171,174,182,193,195,196,197,205,210,215,217,224,230,247,250,256,262,263,439,440],$VSa=[1,1136],$VTa=[1,1135],$VUa=[2,3064],$VVa=[19,577],$VWa=[19,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,160,161,165,181,195,201,296,337,402],$VXa=[6,10,267,273,348,577],$VYa=[19,267,273,348,577],$VZa=[1,1145],$V_a=[1,1146],$V$a=[2,6,10,26,28,30,32,33,34,37,38,39,40,42,43,45,46,47,48,49,50,51,52,54,56,58,59,60,61,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,85,86,87,88,89,90,91,92,93,95,96,97,98,99,100,101,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,128,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,156,157,158,160,161,163,164,165,166,167,168,169,170,171,172,173,174,175,176,177,178,179,180,181,182,183,184,185,186,187,188,189,190,191,192,193,194,195,196,197,198,199,200,201,202,203,204,205,206,207,208,209,210,211,212,213,214,215,216,217,218,219,220,221,222,223,224,225,226,227,228,229,230,231,232,233,234,235,236,237,238,239,240,241,242,243,244,245,246,247,248,249,250,251,252,253,254,255,256,257,258,259,260,261,262,263,264,265,266,267,268,269,270,271,272,273,274,275,276,277,278,279,280,281,282,283,284,285,286,287,288,289,290,291,292,293,294,295,296,297,298,299,300,301,302,303,304,305,306,307,308,309,310,311,312,313,314,315,316,317,318,319,320,321,322,323,324,325,326,327,328,329,330,331,332,333,334,335,336,337,338,339,340,341,342,343,344,345,346,347,348,349,350,351,352,353,354,355,356,357,358,359,360,361,362,363,364,365,366,367,368,369,370,371,372,373,374,375,376,377,378,379,380,381,382,383,384,385,386,387,388,389,390,391,392,393,394,395,396,397,398,399,400,401,402,403,404,438,439,440,452,569,570,571,577,763,826,868,930,931,933,1166,1190,1191,1192,1193,1195,1213,1227,1252,1253,1278,1314],$V0b=[19,837],$V1b=[2,2833],$V2b=[1,1152],$V3b=[1,1151],$V4b=[1,1155],$V5b=[2,114],$V6b=[1,1157],$V7b=[1,1159],$V8b=[6,10,19,307,324,394,837],$V9b=[6,10,19,307,394,837],$Vab=[6,10,324],$Vbb=[2,694],$Vcb=[1,1164],$Vdb=[2,6,10,19,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,160,161,165,167,168,170,175,176,180,183,184,188,189,194,203,206,207,208,209,212,213,231,233,239,242,244,246,249,250,251,254,258,264,265,266,267,269,273,274,275,281,282,283,285,286,287,288,289,290,293,294,297,299,300,301,302,305,307,308,309,310,311,312,313,314,316,317,318,319,320,321,322,323,324,325,326,328,330,331,332,333,334,335,336,338,339,340,341,343,344,345,347,348,349,350,351,352,385,386,387,388,389,390,391,392,393,394,395,398,399,402,403,441,445,452,543,571,577,583,656,663,668,762,826,837,868,906,908,910,957,975,1006,1190],$Veb=[1,1166],$Vfb=[1,1165],$Vgb=[6,10,19,307,324,394,398,837],$Vhb=[2,2872],$Vib=[2,6,10,19,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,160,161,165,167,168,170,175,176,180,183,184,188,189,194,203,204,206,207,208,209,212,213,231,233,239,242,244,246,249,250,251,254,258,264,265,266,267,269,273,274,275,281,282,283,285,286,287,288,289,290,293,294,297,299,300,301,302,305,307,308,309,310,311,312,313,314,316,317,318,319,320,321,322,323,324,325,326,328,330,331,332,333,334,335,336,338,339,340,341,343,344,345,347,348,349,350,351,352,385,386,387,388,389,390,391,392,393,394,395,398,399,402,403,441,445,452,543,571,577,583,656,663,668,762,826,837,868,906,908,910,952,957,975,1006,1190],$Vjb=[2,36],$Vkb=[2,155],$Vlb=[6,10,307],$Vmb=[2,6,10,19,170,176,184,206,231,242,307,309,310,320,325,347,351,394,399,445,577,656,663,957,1190],$Vnb=[2,6,10,170,176,184,206,231,242,307,309,310,320,325,347,351,394,399,445,577,656,663,1190],$Vob=[6,10,19,170,176,184,206,231,242,307,309,310,320,325,347,351,394,399,445,577,656,663,957,1190],$Vpb=[2,1293],$Vqb=[1,1175],$Vrb=[1,1176],$Vsb=[1,1180],$Vtb=[1,1177],$Vub=[1,1174],$Vvb=[1,1181],$Vwb=[1,1178],$Vxb=[1,1182],$Vyb=[1,1179],$Vzb=[1,1186],$VAb=[1,1187],$VBb=[1,1191],$VCb=[1,1188],$VDb=[1,1192],$VEb=[1,1189],$VFb=[1,1193],$VGb=[1,1190],$VHb=[2,1372],$VIb=[6,10,19,170,176,184,206,231,242,264,265,266,294,307,308,309,310,313,317,318,320,324,325,326,333,338,347,351,394,399,445,577,656,663,957,1190],$VJb=[2,1413],$VKb=[2,6,10,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,160,161,167,170,176,184,206,231,242,264,265,266,286,294,307,308,309,310,313,317,318,320,324,325,326,333,338,347,351,394,399,402,445,577,656,663,1190],$VLb=[1,1203],$VMb=[2,6,10,170,176,184,206,231,242,264,265,266,294,307,308,309,310,313,317,318,320,324,325,326,333,338,347,351,394,399,445,577,656,663,1190],$VNb=[2,6,10,19,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,160,161,167,170,176,184,206,231,242,264,265,266,286,294,307,308,309,310,313,317,318,320,324,325,326,333,338,347,351,394,399,402,445,577,656,663,957,1190],$VOb=[6,10,19,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,160,161,167,170,176,184,188,203,206,212,231,242,244,258,264,265,266,267,269,273,274,275,286,294,307,308,309,310,311,313,317,318,320,322,324,325,326,328,330,333,335,338,339,347,348,351,352,394,398,399,402,441,445,452,543,577,656,663,762,826,837,868,906,908,910,957,1190],$VPb=[2,711],$VQb=[1,1209],$VRb=[1,1208],$VSb=[1,1207],$VTb=[352,577],$VUb=[2,1391],$VVb=[1,1215],$VWb=[2,6,10,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,160,161,167,170,176,184,188,203,206,212,231,242,244,258,264,265,266,267,269,273,274,275,286,294,307,308,309,310,313,317,318,320,322,324,325,326,328,330,333,335,338,339,347,348,351,352,394,398,399,402,445,452,543,577,656,663,762,826,837,868,906,908,910,1190],$VXb=[19,324],$VYb=[6,10,19,170,176,184,206,231,242,309,310,320,325,347,351,399,445,577,656,663,957,1190],$VZb=[2,1419],$V_b=[2,6,10,170,176,206,231,242,309,310,320,325,347,351,399,445,577,656,663,1190],$V$b=[2,6,10,170,176,184,206,231,242,309,310,320,325,347,351,399,445,577,656,663,1190],$V0c=[2,6,10,19,170,176,184,206,231,242,309,310,320,325,347,351,394,399,445,577,656,663,957,1190],$V1c=[207,281,387,395],$V2c=[1,1229],$V3c=[1,1230],$V4c=[2,896],$V5c=[2,6,10,307,398,399,577,1190,1192,1227],$V6c=[2,6,10,19,307,394,398,399,577,1190,1192,1227],$V7c=[2,6,10,399,957],$V8c=[1,1246],$V9c=[1,1256],$Vac=[1,1258],$Vbc=[1,1260],$Vcc=[1,1269],$Vdc=[1,1278],$Vec=[1,1279],$Vfc=[26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,160,161,402],$Vgc=[178,193,222,262,342],$Vhc=[1,1350],$Vic=[2,872],$Vjc=[2,6,10,347,399,957],$Vkc=[2,170],$Vlc=[6,10,26,30,59,74,79,80,97,113,131,145,182,218,307,339,352,438,439,440,452,569,570,571,577,763,826,868,930,931,933,1166,1190,1191,1192,1193,1195,1213,1227,1252,1253,1278,1314],$Vmc=[6,10,19],$Vnc=[2,665],$Voc=[2,2077],$Vpc=[1,1397],$Vqc=[1,1399],$Vrc=[19,307,394],$Vsc=[1,1410],$Vtc=[19,66,238],$Vuc=[2,3136],$Vvc=[1,1419],$Vwc=[19,66,185,238],$Vxc=[2,1498],$Vyc=[2,3155],$Vzc=[6,10,19,339],$VAc=[6,10,339],$VBc=[6,10,19,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,160,161,165,188,328,339,398,402],$VCc=[2,764],$VDc=[6,10,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,160,161,165,188,328,339,402],$VEc=[2,19,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,160,161,168,207,236,281,285,292,303,304,311,321,322,323,346,353,354,355,356,357,358,359,360,361,362,363,364,365,366,367,368,370,371,372,373,374,375,376,377,378,379,380,381,382,383,391,392,395,396,397,398,402,403,404,441,762,763,794,806],$VFc=[2,894],$VGc=[1,1439],$VHc=[2,19,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,160,161,168,207,236,260,281,285,292,303,304,311,321,322,323,346,353,354,355,356,357,358,359,360,361,362,363,364,365,366,367,368,370,371,372,373,374,375,376,377,378,379,380,381,382,383,391,392,394,395,396,397,398,399,402,403,404,441,577,762,763,794,806],$VIc=[6,10,19,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,160,161,165,311,402],$VJc=[19,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,160,161,311,402],$VKc=[19,193,262,342],$VLc=[2,630],$VMc=[1,1450],$VNc=[1,1451],$VOc=[2,658],$VPc=[1,1454],$VQc=[2,654],$VRc=[26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,160,161],$VSc=[6,10,19,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,160,161,402],$VTc=[2,655],$VUc=[1,1471],$VVc=[1,1501],$VWc=[1,1502],$VXc=[1,1509],$VYc=[1,1510],$VZc=[1,1512],$V_c=[1,1514],$V$c=[19,319],$V0d=[1,1517],$V1d=[1,1521],$V2d=[2,3294],$V3d=[1,1527],$V4d=[6,10,19,319,403],$V5d=[2,662],$V6d=[1,1549],$V7d=[6,10,19,319],$V8d=[2,3378],$V9d=[2,624],$Vad=[19,193,262,342,1101],$Vbd=[6,10,19,324],$Vcd=[6,10,19,312,319,403],$Vdd=[19,230],$Ved=[6,10,170,176,206,231,242,309,310,320,325,445,656,663],$Vfd=[2,970],$Vgd=[1,1566],$Vhd=[1,1572],$Vid=[2,2963],$Vjd=[6,10,1190],$Vkd=[2,3019],$Vld=[1,1585],$Vmd=[1,1613],$Vnd=[1,1624],$Vod=[1,1612],$Vpd=[1,1596],$Vqd=[1,1594],$Vrd=[1,1679],$Vsd=[1,1611],$Vtd=[1,1614],$Vud=[1,1590],$Vvd=[1,1606],$Vwd=[1,1678],$Vxd=[1,1656],$Vyd=[1,1639],$Vzd=[1,1647],$VAd=[1,1667],$VBd=[1,1668],$VCd=[1,1665],$VDd=[1,1666],$VEd=[1,1648],$VFd=[1,1673],$VGd=[1,1676],$VHd=[1,1677],$VId=[1,1657],$VJd=[1,1658],$VKd=[1,1659],$VLd=[1,1660],$VMd=[1,1661],$VNd=[1,1663],$VOd=[1,1670],$VPd=[1,1671],$VQd=[1,1672],$VRd=[1,1655],$VSd=[1,1641],$VTd=[1,1662],$VUd=[1,1669],$VVd=[1,1664],$VWd=[1,1674],$VXd=[1,1675],$VYd=[1,1638],$VZd=[1,1593],$V_d=[1,1592],$V$d=[1,1591],$V0e=[1,1595],$V1e=[1,1653],$V2e=[1,1654],$V3e=[1,1615],$V4e=[1,1616],$V5e=[1,1640],$V6e=[2,625],$V7e=[1,1684],$V8e=[2,1954],$V9e=[1,1703],$Vae=[2,1955],$Vbe=[1,1721],$Vce=[1,1729],$Vde=[1,1713],$Vee=[1,1726],$Vfe=[1,1724],$Vge=[1,1728],$Vhe=[1,1730],$Vie=[1,1727],$Vje=[1,1725],$Vke=[1,1716],$Vle=[1,1717],$Vme=[1,1722],$Vne=[19,39,172,188,250,311,328,898],$Voe=[1,1733],$Vpe=[1,1741],$Vqe=[1,1742],$Vre=[2,1851],$Vse=[1,1746],$Vte=[1,1760],$Vue=[2,1962],$Vve=[1,1762],$Vwe=[19,39,898],$Vxe=[19,188,328],$Vye=[1,1771],$Vze=[1,1772],$VAe=[19,83,84],$VBe=[19,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,160,161,402,860],$VCe=[19,291,398],$VDe=[1,1773],$VEe=[2,19,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,160,161,168,175,211,240,251,268,270,271,277,289,290,293,297,299,305,314,340,341,344,345,349,352,398,399,402,577,1040],$VFe=[2,3030],$VGe=[1,1787],$VHe=[1,1789],$VIe=[6,10,352,577,1190],$VJe=[1,1792],$VKe=[1,1794],$VLe=[1,1797],$VMe=[1,1799],$VNe=[1,1805],$VOe=[1,1809],$VPe=[1,1807],$VQe=[188,250,328],$VRe=[1,1814],$VSe=[1,1825],$VTe=[1,1832],$VUe=[2,3062],$VVe=[1,1837],$VWe=[19,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,160,161,262,402],$VXe=[1,1849],$VYe=[1,1845],$VZe=[1,1850],$V_e=[1,1843],$V$e=[1,1844],$V0f=[1,1846],$V1f=[1,1847],$V2f=[1,1848],$V3f=[1,1869],$V4f=[1,1867],$V5f=[1,1868],$V6f=[2,1297],$V7f=[19,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,160,161,398,402],$V8f=[2,1304],$V9f=[1,1890],$Vaf=[1,1889],$Vbf=[2,6,10,19,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,160,161,266,273,279,294,308,313,317,318,326,333,338,347,398,399,402],$Vcf=[1,1892],$Vdf=[1,1894],$Vef=[1,1896],$Vff=[1,1898],$Vgf=[1,1900],$Vhf=[1,1902],$Vif=[1,1905],$Vjf=[1,1911],$Vkf=[26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,160,161,398,402],$Vlf=[2,6,10,19,170,176,184,206,231,242,265,266,294,307,308,309,310,313,317,318,320,324,325,326,333,338,347,351,394,399,445,577,656,663,957,1190],$Vmf=[2,1383],$Vnf=[1,1933],$Vof=[2,6,10,170,176,184,206,231,242,265,266,294,307,308,309,310,313,317,318,320,324,325,326,333,338,347,351,394,399,445,577,656,663,1190],$Vpf=[2,6,10,19,170,176,184,206,231,242,264,265,266,294,307,308,309,310,313,317,318,320,324,325,326,333,338,347,351,394,399,445,577,583,656,663,957,1190],$Vqf=[1,1943],$Vrf=[2,6,10,19,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,160,161,167,170,176,183,184,194,206,209,212,231,233,239,242,244,246,249,250,258,266,274,275,283,286,287,288,294,300,301,302,307,308,309,310,312,313,316,317,318,319,320,322,323,325,326,331,332,333,334,335,336,338,343,347,350,351,352,382,383,385,386,387,388,389,390,391,392,393,394,399,402,441,445,452,543,571,577,583,656,663,668,957,1190],$Vsf=[1,1949],$Vtf=[1,1948],$Vuf=[1,1977],$Vvf=[1,1976],$Vwf=[1,1975],$Vxf=[1,1974],$Vyf=[2,919],$Vzf=[1,1984],$VAf=[1,1992],$VBf=[1,1993],$VCf=[1,1991],$VDf=[1,1995],$VEf=[1,1996],$VFf=[2,6,10,307,394,398,399,577,1190,1192,1227],$VGf=[2,6,10,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,160,161,167,170,176,184,188,203,206,212,231,242,244,258,264,265,266,267,269,273,274,275,286,294,307,308,309,310,311,313,317,318,320,322,324,325,326,328,330,333,335,338,339,347,348,351,352,394,398,399,402,445,452,543,577,656,663,762,826,837,868,906,908,910,957,1190],$VHf=[1,2012],$VIf=[1,2015],$VJf=[307,394],$VKf=[2,6,10,170,176,184,206,231,242,307,309,310,320,325,347,351,394,399,445,577,656,663,957,1190],$VLf=[2,6,10,170,176,184,206,231,242,264,265,266,294,307,308,309,310,313,317,318,320,324,325,326,333,338,347,351,394,399,445,577,656,663,957,1190],$VMf=[1,2039],$VNf=[6,10,319],$VOf=[1,2094],$VPf=[1,2096],$VQf=[1,2111],$VRf=[1,2105],$VSf=[1,2103],$VTf=[1,2099],$VUf=[1,2113],$VVf=[1,2117],$VWf=[1,2118],$VXf=[1,2115],$VYf=[1,2112],$VZf=[1,2102],$V_f=[1,2101],$V$f=[1,2100],$V0g=[1,2104],$V1g=[1,2114],$V2g=[2,6,10,170,176,184,206,231,242,309,310,320,325,347,351,399,445,577,656,663,957,1190],$V3g=[1,2121],$V4g=[6,10,43],$V5g=[2,2070],$V6g=[6,10,394],$V7g=[2,6,10,19,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,160,161,167,170,176,183,184,194,206,209,212,231,233,239,242,244,246,249,250,258,266,274,275,283,286,287,288,294,300,301,302,307,308,309,310,312,313,316,317,318,319,320,322,323,325,326,331,332,333,334,335,336,338,343,347,350,351,352,385,386,387,388,389,390,391,392,393,394,399,402,445,452,543,571,577,583,656,663,668,957,1190],$V8g=[2,1248],$V9g=[1,2150],$Vag=[1,2164],$Vbg=[1,2166],$Vcg=[1,2179],$Vdg=[1,2180],$Veg=[1,2199],$Vfg=[1,2216],$Vgg=[1,2215],$Vhg=[1,2217],$Vig=[6,10,27,31,36,37,41,44,53,55,57,102,103,104,114,127,129,188,322,328,339,762,826,868,906,908,910],$Vjg=[2,2113],$Vkg=[6,10,19,37,40,75,90,114,117,121,167,212,244,258,269,274,275,286,319,328,335,398,452,543,957,975],$Vlg=[2,726],$Vmg=[1,2253],$Vng=[6,10,207],$Vog=[1,2296],$Vpg=[1,2295],$Vqg=[1,2302],$Vrg=[1,2301],$Vsg=[2,3283],$Vtg=[2,3295],$Vug=[2,3311],$Vvg=[1,2311],$Vwg=[2,3324],$Vxg=[1,2326],$Vyg=[1,2327],$Vzg=[1,2329],$VAg=[2,640],$VBg=[1,2334],$VCg=[1,2335],$VDg=[2,3365],$VEg=[1,2339],$VFg=[1,2344],$VGg=[2,3383],$VHg=[1,2351],$VIg=[2,6,10,170,176,206,242,266,294,308,310,313,317,318,320,325,326,333,338,347,399,656,663,957,1190],$VJg=[2,975],$VKg=[1,2366],$VLg=[1,2364],$VMg=[1,2365],$VNg=[2,6,10,19,170,176,206,231,242,266,294,308,309,310,313,317,318,320,325,326,333,338,347,399,445,656,663,957,1190],$VOg=[2,971],$VPg=[2,6,10,170,176,206,242,266,294,308,310,313,317,318,320,325,326,333,338,347,399,656,663,1190],$VQg=[6,10,170,176,206,242,310,320,325,347,399,656,663,957,1190],$VRg=[6,10,170,176,206,231,242,309,310,320,325,445,656,663,1190],$VSg=[1,2401],$VTg=[1,2402],$VUg=[1,2400],$VVg=[1,2399],$VWg=[1,2404],$VXg=[1,2403],$VYg=[1,2395],$VZg=[1,2394],$V_g=[1,2390],$V$g=[1,2391],$V0h=[1,2392],$V1h=[1,2393],$V2h=[1,2396],$V3h=[1,2397],$V4h=[1,2411],$V5h=[1,2410],$V6h=[1,2409],$V7h=[1,2413],$V8h=[1,2412],$V9h=[1,2405],$Vah=[1,2406],$Vbh=[1,2407],$Vch=[1,2408],$Vdh=[1,2414],$Veh=[1,2415],$Vfh=[1,2416],$Vgh=[1,2439],$Vhh=[1,2440],$Vih=[1,2428],$Vjh=[1,2427],$Vkh=[1,2422],$Vlh=[1,2438],$Vmh=[1,2421],$Vnh=[1,2442],$Voh=[1,2441],$Vph=[1,2443],$Vqh=[1,2430],$Vrh=[1,2429],$Vsh=[1,2423],$Vth=[1,2424],$Vuh=[1,2425],$Vvh=[1,2426],$Vwh=[1,2431],$Vxh=[1,2432],$Vyh=[1,2433],$Vzh=[2,6,10,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,160,161,167,170,176,183,184,194,206,209,231,233,239,242,246,266,283,286,287,288,294,300,301,302,307,308,309,310,312,313,317,318,319,320,322,325,326,332,333,334,338,343,347,350,351,352,385,386,387,388,389,390,391,392,393,394,399,402,445,571,577,656,663,668,1190],$VAh=[1,2450],$VBh=[1,2454],$VCh=[1,2470],$VDh=[1,2473],$VEh=[2,6,10,19,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,160,161,167,170,176,183,184,194,206,209,231,233,239,242,246,250,266,283,286,287,288,294,300,301,302,307,308,309,310,312,313,316,317,318,319,320,322,325,326,331,332,333,334,336,338,343,347,350,351,352,385,386,387,388,389,390,391,392,393,394,399,402,445,571,577,583,656,663,668,957,1190],$VFh=[2,1221],$VGh=[1,2476],$VHh=[2,6,10,19,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,160,161,167,170,176,183,184,194,206,209,231,233,239,242,246,249,250,266,283,286,287,288,294,300,301,302,307,308,309,310,312,313,316,317,318,319,320,322,323,325,326,331,332,333,334,336,338,343,347,350,351,352,385,386,387,388,389,390,391,392,393,394,399,402,445,452,571,577,583,656,663,668,957,1190],$VIh=[2,1233],$VJh=[2,1465],$VKh=[1,2484],$VLh=[1,2486],$VMh=[2,6,10,19,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,160,161,167,170,176,183,184,194,206,207,209,231,233,239,242,246,249,250,266,281,283,286,287,288,294,300,301,302,307,308,309,310,312,313,316,317,318,319,320,322,323,325,326,331,332,333,334,336,338,343,347,350,351,352,385,386,387,388,389,390,391,392,393,394,395,398,399,402,445,452,571,577,583,656,663,668,957,1190],$VNh=[2,6,10,19,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,160,161,167,170,176,183,184,194,206,209,231,233,239,242,246,249,250,266,283,286,287,288,294,300,301,302,307,308,309,310,312,313,316,317,318,319,320,322,323,325,326,327,331,332,333,334,336,338,343,347,350,351,352,385,386,387,388,389,390,391,392,393,394,399,402,445,452,571,577,583,656,663,668,957,1190],$VOh=[2,793],$VPh=[1,2497],$VQh=[1,2498],$VRh=[1,2513],$VSh=[1,2536],$VTh=[1,2545],$VUh=[1,2543],$VVh=[1,2544],$VWh=[1,2550],$VXh=[1,2551],$VYh=[1,2552],$VZh=[1,2553],$V_h=[1,2554],$V$h=[1,2555],$V0i=[1,2556],$V1i=[1,2557],$V2i=[1,2558],$V3i=[1,2560],$V4i=[1,2561],$V5i=[1,2562],$V6i=[1,2563],$V7i=[1,2559],$V8i=[1,2565],$V9i=[2,756],$Vai=[1,2571],$Vbi=[19,32,67,85,89,95,109,124,211,240,268,270,271,277,1040],$Vci=[1,2577],$Vdi=[6,10,19,352],$Vei=[2,1897],$Vfi=[2,6,10,19,29,35,37,40,63,69,75,86,90,105,114,117,121,152,153,154,155,167,212,244,249,258,269,274,275,286,312,322,323,328,335,352,385,387,389,394,399,452,543,577,952,957,1190],$Vgi=[2,643],$Vhi=[1,2602],$Vii=[2,1963],$Vji=[6,10,75,114,117,121,167,212,244,274,275,286,335,543],$Vki=[1,2616],$Vli=[1,2631],$Vmi=[1,2634],$Vni=[6,10,117,274,352,577,1190],$Voi=[2,3021],$Vpi=[1,2639],$Vqi=[19,117,274,352,577,1209],$Vri=[1,2642],$Vsi=[1,2654],$Vti=[6,10,352],$Vui=[1,2667],$Vvi=[1,2669],$Vwi=[2,3035],$Vxi=[1,2681],$Vyi=[1,2691],$Vzi=[6,10,19,307,837],$VAi=[2,2900],$VBi=[1,2707],$VCi=[1,2706],$VDi=[1,2708],$VEi=[6,10,19,352,394],$VFi=[1,2718],$VGi=[1,2717],$VHi=[2,6,10,242,266,294,308,313,317,318,320,326,333,338,347,399,656,663,1190],$VIi=[2,6,10,19,242,266,294,308,313,317,318,320,326,333,338,347,394,399,656,663,957,1190],$VJi=[1,2729],$VKi=[2,6,10,19,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,160,161,170,176,184,206,231,242,266,294,307,308,309,310,313,317,318,320,325,326,333,338,347,351,394,398,399,402,445,577,656,663,1190],$VLi=[2,6,10,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,160,161,170,176,184,206,231,242,266,273,279,294,307,308,309,310,313,317,318,320,325,326,333,338,347,351,394,398,399,402,445,577,656,663,1190],$VMi=[1,2730],$VNi=[1,2734],$VOi=[1,2736],$VPi=[1,2738],$VQi=[1,2740],$VRi=[1,2744],$VSi=[1,2746],$VTi=[1,2748],$VUi=[1,2750],$VVi=[2,6,10,170,176,184,206,231,242,266,294,307,308,309,310,313,317,318,320,325,326,333,338,347,351,394,399,445,577,656,663,1190],$VWi=[1,2759],$VXi=[1,2763],$VYi=[1,2765],$VZi=[1,2767],$V_i=[2,712],$V$i=[1,2775],$V0j=[2,6,10,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,160,161,165,167,170,176,183,184,188,194,203,206,207,209,212,231,233,239,242,244,246,258,264,265,266,267,269,273,274,275,281,283,286,287,288,294,300,301,302,307,308,309,310,312,313,317,318,319,320,322,324,325,326,328,330,332,333,334,335,338,339,343,347,348,350,351,352,385,386,387,388,389,390,391,392,393,394,395,398,399,402,445,452,543,571,577,656,663,668,762,826,837,868,906,908,910,975,1190],$V1j=[2,6,10,19,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,160,161,167,170,176,183,184,194,206,209,231,233,239,242,246,250,264,265,266,283,286,287,288,294,300,301,302,307,308,309,310,312,313,316,317,318,319,320,322,324,325,326,331,332,333,334,336,338,343,347,350,351,352,385,386,387,388,389,390,391,392,393,394,399,402,445,571,577,583,656,663,668,957,1190],$V2j=[2,6,10,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,160,161,167,170,176,183,184,194,206,209,231,233,239,242,246,264,265,266,283,286,287,288,294,300,301,302,307,308,309,310,312,313,317,318,319,320,322,324,325,326,332,333,334,338,343,347,350,351,352,385,386,387,388,389,390,391,392,393,394,399,402,445,571,577,656,663,668,1190],$V3j=[2,6,10,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,160,161,167,168,170,176,183,184,188,194,206,207,209,212,231,233,236,239,242,244,246,247,255,258,264,265,266,267,269,273,274,275,281,283,285,286,287,288,292,294,300,301,302,303,304,307,308,309,310,311,312,313,315,317,318,319,320,321,322,323,324,325,326,327,328,332,333,334,335,338,343,346,347,348,350,351,352,353,354,355,356,357,358,359,360,361,362,363,364,365,366,367,368,370,371,372,373,374,375,376,377,378,379,380,381,382,383,385,386,387,388,389,390,391,392,393,394,395,396,397,398,399,402,403,404,445,452,543,571,577,656,663,668,762,763,794,837,1190,1192,1227],$V4j=[1,2778],$V5j=[2,6,10,19,170,176,184,206,231,242,309,310,320,325,347,351,399,445,577,656,663,957,1190],$V6j=[1,2791],$V7j=[6,10,19,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,160,161,167,286,957],$V8j=[1,2816],$V9j=[1,2815],$Vaj=[117,274,352,577],$Vbj=[1,2882],$Vcj=[1,2881],$Vdj=[1,2875],$Vej=[1,2880],$Vfj=[1,2889],$Vgj=[1,2884],$Vhj=[1,2883],$Vij=[1,2876],$Vjj=[1,2877],$Vkj=[1,2878],$Vlj=[1,2879],$Vmj=[1,2885],$Vnj=[1,2886],$Voj=[1,2887],$Vpj=[1,2897],$Vqj=[1,2898],$Vrj=[2,6,10,19,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,160,161,167,170,176,183,184,194,206,209,231,233,239,242,246,249,250,266,283,286,287,288,294,300,301,302,307,308,309,310,312,313,316,317,318,319,320,322,323,325,326,331,332,333,334,336,338,343,347,350,351,352,385,386,387,388,389,390,391,392,393,394,398,399,402,445,452,571,577,583,656,663,668,957,1190],$Vsj=[2,6,10,19,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,160,161,167,168,170,175,176,183,184,188,194,206,207,209,231,233,239,242,246,249,250,251,266,281,283,285,286,287,288,289,290,293,294,297,299,300,301,302,305,307,308,309,310,312,313,314,316,317,318,319,320,321,322,323,325,326,328,331,332,333,334,336,338,339,340,341,343,344,345,347,349,350,351,352,385,386,387,388,389,390,391,392,393,394,395,398,399,402,445,452,571,577,583,656,663,668,868,957,1190],$Vtj=[2,6,10,347,399],$Vuj=[2,1249],$Vvj=[1,2938],$Vwj=[2,2906],$Vxj=[1,2954],$Vyj=[6,10,19,307],$Vzj=[6,10,19,351],$VAj=[2,3413],$VBj=[1,2975],$VCj=[6,10,351],$VDj=[1,2978],$VEj=[6,10,19,307,350,351,394],$VFj=[6,10,307,351],$VGj=[6,10,307,351,394],$VHj=[2,19,40,387,394,399,452],$VIj=[2,772],$VJj=[1,2984],$VKj=[2,867],$VLj=[1,2987],$VMj=[1,3001],$VNj=[1,3000],$VOj=[1,2999],$VPj=[2,6,10,19,170,176,206,231,242,307,309,310,320,325,347,351,394,399,445,583,656,663,957,1190],$VQj=[2,1699],$VRj=[2,6,10,170,176,206,231,242,307,309,310,320,325,347,351,399,445,656,663,1190],$VSj=[2,1265],$VTj=[2,6,10,170,176,206,231,242,307,309,310,320,325,347,351,394,399,445,656,663,1190],$VUj=[1,3010],$VVj=[2,2118],$VWj=[1,3027],$VXj=[1,3028],$VYj=[1,3030],$VZj=[6,10,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,160,161,352,402,577,1190],$V_j=[19,40,121,167,286,452],$V$j=[2,2585],$V0k=[40,121,167,286,452],$V1k=[1,3038],$V2k=[6,10,37,40,75,90,114,117,121,167,212,244,258,269,274,275,286,319,328,335,398,452,543,975],$V3k=[1,3046],$V4k=[1,3050],$V5k=[1,3053],$V6k=[2,645],$V7k=[1,3063],$V8k=[1,3065],$V9k=[1,3064],$Vak=[1,3066],$Vbk=[2,2747],$Vck=[1,3075],$Vdk=[1,3074],$Vek=[2,3240],$Vfk=[1,3099],$Vgk=[2,6,10,19,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,160,161,167,170,176,183,184,188,194,204,206,209,212,214,220,225,231,233,235,239,242,243,244,245,246,248,249,250,257,258,266,269,274,275,278,283,286,287,288,294,300,301,302,307,308,309,310,312,313,316,317,318,319,320,321,322,323,325,326,328,331,332,333,334,335,336,338,343,347,350,351,352,385,386,387,388,389,390,391,392,393,394,399,402,445,452,543,571,577,583,656,663,668,952,957,1055,1190,1209],$Vhk=[1,3104],$Vik=[2,6,10,19,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,160,161,167,170,176,183,184,194,206,209,212,231,233,239,242,244,246,249,250,258,266,269,274,275,283,286,287,288,294,300,301,302,307,308,309,310,312,313,316,317,318,319,320,322,323,325,326,328,331,332,333,334,335,336,338,343,347,350,351,352,385,386,387,388,389,390,391,392,393,394,399,402,445,452,543,571,577,583,656,663,668,952,957,1190],$Vjk=[2,3275],$Vkk=[1,3105],$Vlk=[1,3107],$Vmk=[2,3298],$Vnk=[2,3313],$Vok=[1,3115],$Vpk=[2,687],$Vqk=[2,3374],$Vrk=[2,6,10,170,176,206,242,266,294,308,313,317,318,320,325,326,333,338,347,399,656,663,957,1190],$Vsk=[2,1525],$Vtk=[1,3138],$Vuk=[2,976],$Vvk=[19,291],$Vwk=[2,1085],$Vxk=[2,6,10,170,176,206,242,266,294,308,313,317,318,320,325,326,333,338,347,399,656,663,1190],$Vyk=[6,10,170,176,206,242,320,325,347,399,656,663,957,1190],$Vzk=[1,3145],$VAk=[2,6,10,170,176,206,231,242,266,294,308,309,310,313,317,318,320,325,326,333,338,347,399,445,656,663,1190],$VBk=[1,3160],$VCk=[151,298,304,323,346],$VDk=[2,1262],$VEk=[2,3099],$VFk=[1,3237],$VGk=[1,3251],$VHk=[2,6,10,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,160,161,167,170,176,183,184,194,206,209,231,242,246,266,283,286,287,288,294,300,301,302,307,308,309,310,313,317,318,320,322,325,326,333,338,343,347,350,351,352,385,386,394,399,402,445,571,577,656,663,668,1190],$VIk=[2,6,10,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,160,161,167,170,176,183,184,194,206,209,231,242,246,266,283,286,287,288,294,300,301,302,307,308,309,310,312,313,317,318,320,322,325,326,333,338,343,347,350,351,352,385,386,391,394,399,402,445,571,577,656,663,668,1190],$VJk=[2,6,10,19,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,160,161,167,170,176,183,184,194,206,209,231,242,246,250,266,283,286,287,288,294,300,301,302,307,308,309,310,313,317,318,320,322,325,326,331,333,336,338,343,347,350,351,352,385,386,394,399,402,445,571,577,583,656,663,668,957,1190],$VKk=[2,1088],$VLk=[2,1089],$VMk=[2,1090],$VNk=[2,6,10,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,160,161,167,170,176,183,184,194,206,209,231,242,246,266,283,286,287,288,294,300,301,302,307,308,309,310,313,317,318,320,322,325,326,333,338,343,347,350,351,352,385,386,387,388,389,390,391,392,393,394,399,402,445,571,577,656,663,668,1190],$VOk=[2,6,10,19,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,160,161,167,170,176,183,184,194,206,209,231,242,246,250,266,283,286,287,288,294,300,301,302,307,308,309,310,313,317,318,320,322,325,326,331,333,336,338,343,347,350,351,352,385,386,387,388,389,390,391,392,393,394,399,402,445,571,577,583,656,663,668,957,1190],$VPk=[2,1091],$VQk=[1,3254],$VRk=[1,3261],$VSk=[1,3257],$VTk=[1,3260],$VUk=[1,3259],$VVk=[1,3271],$VWk=[2,301,302],$VXk=[2,19,301,302,350],$VYk=[1,3283],$VZk=[1,3284],$V_k=[1,3291],$V$k=[1,3292],$V0l=[1,3299],$V1l=[1,3304],$V2l=[1,3307],$V3l=[1,3309],$V4l=[1,3310],$V5l=[1,3311],$V6l=[1,3312],$V7l=[1,3313],$V8l=[1,3314],$V9l=[1,3315],$Val=[1,3308],$Vbl=[1,3321],$Vcl=[1,3322],$Vdl=[1,3320],$Vel=[1,3327],$Vfl=[1,3328],$Vgl=[19,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,160,161,168,207,209,236,281,283,285,292,303,304,311,321,322,323,346,353,354,355,356,357,358,359,360,361,362,363,364,365,366,367,368,370,371,372,373,374,375,376,377,378,379,380,381,382,383,391,395,396,397,398,402,403,404,441,762,763,794],$Vhl=[1,3330],$Vil=[1,3331],$Vjl=[1,3333],$Vkl=[6,10,19,188,207,281,328,395],$Vll=[6,10,188,328],$Vml=[6,10,188,207,281,328,395],$Vnl=[6,10,19,188,212,328,543],$Vol=[2,745],$Vpl=[1,3361],$Vql=[1,3363],$Vrl=[1,3374],$Vsl=[6,10,19,40,75,121,167,212,244,275,286,352,452,543,577,957,1190],$Vtl=[2,2454],$Vul=[1,3389],$Vvl=[2,1868],$Vwl=[6,10,19,167,286,957],$Vxl=[1,3396],$Vyl=[6,10,167,286],$Vzl=[2,1984],$VAl=[1,3407],$VBl=[2,1927],$VCl=[6,10,19,94,394],$VDl=[6,10,94],$VEl=[2,1900],$VFl=[1,3419],$VGl=[1,3420],$VHl=[2,1968],$VIl=[1,3427],$VJl=[1,3426],$VKl=[2,6,10,394,399],$VLl=[2,740],$VMl=[19,315],$VNl=[2,2357],$VOl=[6,10,75,114,117,121,167,212,244,274,275,286,315,335,543],$VPl=[1,3433],$VQl=[2,650],$VRl=[1,3443],$VSl=[1,3444],$VTl=[6,10,352,398,577,1190],$VUl=[2,2395],$VVl=[1,3470],$VWl=[1,3471],$VXl=[19,352,577],$VYl=[1,3479],$VZl=[2,6,10,37,40,75,87,90,114,117,121,167,179,188,212,237,244,258,261,269,274,275,278,286,315,328,335,352,452,543,577,952,1190,1230],$V_l=[6,10,188,212,328,543],$V$l=[1,3489],$V0m=[1,3493],$V1m=[1,3509],$V2m=[1,3508],$V3m=[2,325,394,399],$V4m=[2,1205],$V5m=[1,3513],$V6m=[1,3516],$V7m=[1,3515],$V8m=[2,325,399],$V9m=[19,325,394,399],$Vam=[6,10,188,267,273,328,348,577],$Vbm=[2,2894],$Vcm=[1,3534],$Vdm=[2,2798],$Vem=[2,6,10,37,53,75,114,115,117,121,167,188,212,244,247,258,264,267,273,274,275,286,315,324,328,335,348,352,394,399,543,577,1190],$Vfm=[6,10,19,170,176,184,206,231,242,266,294,307,308,309,310,313,317,318,320,325,326,333,338,347,351,394,399,445,577,656,663,957,1190],$Vgm=[2,1354],$Vhm=[1,3554],$Vim=[1,3553],$Vjm=[1,3556],$Vkm=[2,6,10,170,176,184,206,231,242,266,294,307,308,309,310,313,317,318,320,325,326,333,338,347,351,394,399,445,577,656,663,957,1190],$Vlm=[1,3562],$Vmm=[1,3563],$Vnm=[19,92,336],$Vom=[2,713],$Vpm=[2,6,10,19,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,160,161,167,170,176,184,188,203,206,212,231,242,244,258,264,265,266,267,269,273,274,275,281,286,294,307,308,309,310,311,313,317,318,320,322,324,325,326,328,330,333,335,338,339,347,348,351,352,394,398,399,402,441,445,452,543,577,656,663,762,826,837,868,906,908,910,957,1190],$Vqm=[1,3573],$Vrm=[19,307,837],$Vsm=[2,19,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,160,161,168,285,311,321,762,763],$Vtm=[2,1633],$Vum=[1,3581],$Vvm=[1,3596],$Vwm=[1,3595],$Vxm=[1,3598],$Vym=[1,3619],$Vzm=[1,3620],$VAm=[26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,160,161,168,207,236,281,285,292,303,304,311,321,322,323,346,353,354,355,356,357,358,359,360,361,362,363,364,365,366,367,368,370,371,372,373,374,375,376,377,378,379,380,381,382,383,391,395,396,397,398,402,403,404,762,763,794],$VBm=[267,273,348,577],$VCm=[1,3681],$VDm=[394,399],$VEm=[2,394,399],$VFm=[2,2083],$VGm=[2,2904],$VHm=[2,2907],$VIm=[1,3696],$VJm=[2,3133],$VKm=[1,3699],$VLm=[1,3700],$VMm=[1,3726],$VNm=[1,3740],$VOm=[1,3745],$VPm=[1,3747],$VQm=[2,2114],$VRm=[2,952],$VSm=[2,75,244,952],$VTm=[403,404],$VUm=[121,167,286],$VVm=[1,3790],$VWm=[1,3800],$VXm=[1,3802],$VYm=[1,3816],$VZm=[1,3819],$V_m=[1,3824],$V$m=[1,3809],$V0n=[1,3825],$V1n=[1,3826],$V2n=[1,3817],$V3n=[1,3812],$V4n=[1,3813],$V5n=[1,3821],$V6n=[1,3820],$V7n=[1,3815],$V8n=[1,3814],$V9n=[1,3811],$Van=[1,3810],$Vbn=[1,3818],$Vcn=[1,3823],$Vdn=[1,3808],$Ven=[1,3822],$Vfn=[1,3803],$Vgn=[2,2574],$Vhn=[2,2741],$Vin=[2,3266],$Vjn=[2,6,10,170,176,242,266,294,308,313,317,318,320,325,326,333,338,347,399,656,663,957,1190],$Vkn=[2,1530],$Vln=[1,3872],$Vmn=[2,1526],$Vnn=[2,6,10,170,176,242,266,294,308,313,317,318,320,325,326,333,338,347,399,656,663,1190],$Von=[6,10,170,176,242,320,325,347,399,656,663,957,1190],$Vpn=[1,3882],$Vqn=[170,176,206,242,320,325,656,663],$Vrn=[6,10,170,176,206,231,242,309,310,320,325,351,445,656,663,1190],$Vsn=[2,3026],$Vtn=[1,3902],$Vun=[1,3905],$Vvn=[2,1642],$Vwn=[2,1643],$Vxn=[2,1644],$Vyn=[2,1645],$Vzn=[2,1646],$VAn=[2,6,10,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,160,161,167,170,176,183,184,194,206,209,231,242,246,266,283,286,287,288,294,300,301,302,307,308,309,310,313,317,318,320,322,325,326,333,338,343,347,350,351,352,385,386,387,388,389,390,394,399,402,445,571,577,656,663,668,1190],$VBn=[2,6,10,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,160,161,167,170,176,183,184,194,206,209,231,242,246,266,283,286,287,294,300,301,302,307,308,309,310,313,317,318,320,325,326,333,338,343,347,350,351,352,385,386,394,399,402,445,571,577,656,663,668,1190],$VCn=[2,1263],$VDn=[1,3925],$VEn=[1,3924],$VFn=[1,3922],$VGn=[1,3923],$VHn=[2,6,10,19,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,160,161,167,170,176,183,184,194,206,209,231,242,246,250,266,283,286,287,288,294,300,301,302,307,308,309,310,313,317,318,320,322,325,326,331,333,336,338,343,347,350,351,352,385,386,387,388,389,390,394,399,402,445,571,577,583,656,663,668,957,1190],$VIn=[2,1099],$VJn=[2,1100],$VKn=[2,1101],$VLn=[2,1102],$VMn=[2,6,10,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,160,161,167,170,176,183,184,194,206,209,231,242,246,266,283,286,287,288,294,300,301,302,307,308,309,310,312,313,317,318,320,325,326,333,338,343,347,350,351,352,385,386,391,394,399,402,445,571,577,656,663,668,1190],$VNn=[2,6,10,19,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,160,161,167,170,176,183,184,194,206,209,231,242,246,250,266,283,286,287,294,300,301,302,307,308,309,310,313,317,318,320,325,326,331,333,336,338,343,347,350,351,352,385,386,394,399,402,445,571,577,583,656,663,668,957,1190],$VOn=[2,1109],$VPn=[2,1110],$VQn=[2,1111],$VRn=[2,1112],$VSn=[2,1113],$VTn=[2,3100],$VUn=[1,3941],$VVn=[2,301,302,350],$VWn=[1,3963],$VXn=[2,1448],$VYn=[325,399],$VZn=[2,1476],$V_n=[1,3979],$V$n=[19,327],$V0o=[2,19,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,160,161,168,207,236,281,285,292,303,304,311,321,322,323,346,353,354,355,356,357,358,359,360,361,362,363,364,365,366,367,368,370,371,372,373,374,375,376,377,378,379,380,381,382,383,391,395,396,397,398,399,402,403,404,441,762,763,794],$V1o=[1,4002],$V2o=[1,4015],$V3o=[6,10,19,212,543],$V4o=[2,1986],$V5o=[6,10,212,543],$V6o=[1,4037],$V7o=[1,4043],$V8o=[1,4044],$V9o=[1,4047],$Vao=[2,1866],$Vbo=[6,10,19,40,75,117,121,167,212,244,274,275,286,452,543,957],$Vco=[1,4066],$Vdo=[1,4067],$Veo=[1,4069],$Vfo=[2,1869],$Vgo=[2,2430],$Vho=[1,4074],$Vio=[1,4075],$Vjo=[1,4077],$Vko=[1,4081],$Vlo=[1,4083],$Vmo=[1,4084],$Vno=[1,4085],$Voo=[1,4082],$Vpo=[1,4086],$Vqo=[2,1925],$Vro=[1,4095],$Vso=[2,1873],$Vto=[6,10,19,35,105],$Vuo=[2,1956],$Vvo=[1,4106],$Vwo=[1,4107],$Vxo=[6,10,35,105],$Vyo=[1,4128],$Vzo=[1,4129],$VAo=[1,4126],$VBo=[1,4127],$VCo=[1,4143],$VDo=[1,4145],$VEo=[2,1904],$VFo=[1,4151],$VGo=[2,2169],$VHo=[1,4160],$VIo=[2,2766],$VJo=[1,4163],$VKo=[1,4168],$VLo=[19,167,286],$VMo=[2,603],$VNo=[1,4178],$VOo=[1,4181],$VPo=[1,4186],$VQo=[1,4196],$VRo=[1,4197],$VSo=[1,4194],$VTo=[1,4195],$VUo=[1,4208],$VVo=[2,2797],$VWo=[1,4225],$VXo=[2,2799],$VYo=[2,6,10,19,170,176,184,206,231,242,266,294,307,308,309,310,313,317,318,320,325,326,333,338,347,351,394,399,445,577,656,663,957,1190],$VZo=[1,4248],$V_o=[1,4258],$V$o=[6,10,81,169],$V0p=[2,2060],$V1p=[1,4311],$V2p=[6,10,19,315],$V3p=[2,3144],$V4p=[2,3386],$V5p=[2,3411],$V6p=[2,1700],$V7p=[2,916],$V8p=[1,4353],$V9p=[2,1702],$Vap=[1,4354],$Vbp=[6,10,19,37,40,75,90,114,117,121,167,212,244,258,269,274,275,286,328,335,452,543,957],$Vcp=[2,2156],$Vdp=[6,10,37,40,75,90,114,117,121,167,212,244,258,269,274,275,286,328,335,452,543],$Vep=[1,4368],$Vfp=[1,4367],$Vgp=[2,2126],$Vhp=[1,4371],$Vip=[2,2463],$Vjp=[1,4377],$Vkp=[1,4380],$Vlp=[19,394,399],$Vmp=[167,286],$Vnp=[1,4385],$Vop=[1,4391],$Vpp=[2,2638],$Vqp=[19,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,160,161,168,207,236,281,285,292,303,304,311,321,322,323,346,353,354,355,356,357,358,359,360,361,362,363,364,365,366,367,368,370,371,372,373,374,375,376,377,378,379,380,381,382,383,391,395,396,397,398,402,403,404,762,763,794],$Vrp=[1,4392],$Vsp=[6,10,19,255],$Vtp=[1,4409],$Vup=[2,2545],$Vvp=[2,19,280,394,399],$Vwp=[2,6,10,19,29,35,40,63,75,105,152,153,154,155,244,249,280,322,323,389,394,399,452],$Vxp=[2,821],$Vyp=[1,4415],$Vzp=[1,4419],$VAp=[2,2529],$VBp=[1,4431],$VCp=[1,4432],$VDp=[1,4433],$VEp=[2,3347],$VFp=[2,6,10,170,176,242,266,294,308,313,317,318,320,326,333,338,347,399,656,663,957,1190],$VGp=[2,1014],$VHp=[1,4442],$VIp=[2,1531],$VJp=[2,1527],$VKp=[2,982],$VLp=[1,4448],$VMp=[1,4447],$VNp=[1,4445],$VOp=[2,6,10,170,176,183,206,242,266,294,308,310,313,317,318,320,325,326,333,338,347,352,394,399,656,663,957,1190],$VPp=[2,1002],$VQp=[2,6,10,170,176,242,266,294,308,313,317,318,320,326,333,338,347,399,656,663,1190],$VRp=[6,10,170,176,242,320,347,399,656,663,957,1190],$VSp=[1,4456],$VTp=[170,176,242,320,325,656,663],$VUp=[2,6,10,170,176,183,206,242,266,294,308,310,313,317,318,320,325,326,333,338,347,352,399,656,663,1190],$VVp=[2,6,10,19,170,176,183,206,242,310,320,325,347,352,394,399,656,663,957,1190],$VWp=[1,4484],$VXp=[6,10,19,350],$VYp=[1,4502],$VZp=[19,343],$V_p=[2,3113],$V$p=[1,4517],$V0q=[2,1482],$V1q=[2,6,10,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,160,161,167,170,176,183,184,194,206,209,231,233,239,242,246,266,283,286,287,288,294,300,301,302,307,308,309,310,312,313,317,318,319,320,322,325,326,327,332,333,334,338,343,347,350,351,352,385,386,387,388,389,390,391,392,393,394,399,402,445,571,577,656,663,668,1190],$V2q=[2,6,10,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,160,161,167,170,176,183,184,188,194,206,207,209,231,233,239,242,246,266,281,283,286,287,288,294,300,301,302,307,308,309,310,312,313,317,318,319,320,322,325,326,328,332,333,334,338,343,347,350,351,352,385,386,387,388,389,390,391,392,393,394,395,399,402,445,571,577,656,663,668,1190],$V3q=[1,4573],$V4q=[1,4577],$V5q=[1,4581],$V6q=[2,749],$V7q=[1,4588],$V8q=[2,1987],$V9q=[1,4600],$Vaq=[1,4601],$Vbq=[1,4602],$Vcq=[1,4599],$Vdq=[1,4623],$Veq=[2,2446],$Vfq=[1,4634],$Vgq=[1,4635],$Vhq=[6,10,40,75,121,167,212,244,275,286,452,543],$Viq=[1,4640],$Vjq=[1,4641],$Vkq=[19,123,276],$Vlq=[2,2011],$Vmq=[1,4644],$Vnq=[1,4648],$Voq=[19,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,160,161,207,281,304,323,346,382,383,391,395,403,404,689],$Vpq=[1,4655],$Vqq=[6,10,19,29,35,63,105,394,399],$Vrq=[2,2183],$Vsq=[1,4674],$Vtq=[1,4672],$Vuq=[1,4673],$Vvq=[1,4671],$Vwq=[1,4677],$Vxq=[1,4669],$Vyq=[1,4675],$Vzq=[2,6,10,29,35,63,105,394,399],$VAq=[1,4681],$VBq=[1,4680],$VCq=[2,6,10,19,29,35,40,63,105,152,153,154,155,249,322,323,389,394,399,452],$VDq=[2,6,10,29,35,40,63,105,152,153,154,155,249,322,323,389,394,399,452],$VEq=[2,739],$VFq=[19,352],$VGq=[1,4695],$VHq=[6,10,19,35,37,40,75,90,105,114,117,121,167,212,244,258,269,274,275,286,328,335,452,543,957],$VIq=[1,4699],$VJq=[6,10,35,37,40,75,90,105,114,117,121,167,212,244,258,269,274,275,286,328,335,452,543],$VKq=[6,10,38,40,73,75,117,121,167,212,243,244,274,275,286,321,323,352,452,543,577,957,1190],$VLq=[6,10,19,38,40,73,75,117,121,167,212,243,244,274,275,286,321,323,352,452,543,577,957,1209],$VMq=[2,1206],$VNq=[1,4750],$VOq=[1,4752],$VPq=[2,1355],$VQq=[2,2801],$VRq=[1,4769],$VSq=[1,4771],$VTq=[1,4796],$VUq=[6,10,81],$VVq=[2,2064],$VWq=[2,2061],$VXq=[1,4818],$VYq=[1,4819],$VZq=[2,2908],$V_q=[2,3165],$V$q=[6,10,19,37,75,114,117,121,167,212,244,258,274,275,286,335,543,957],$V0r=[2,2297],$V1r=[1,4856],$V2r=[1,4857],$V3r=[6,10,37,75,114,117,121,167,212,244,258,274,275,286,335,543],$V4r=[1,4860],$V5r=[2,6,10,19],$V6r=[2,2589],$V7r=[1,4890],$V8r=[6,10,255],$V9r=[6,10,19,394],$Var=[2,6,10,242,266,294,308,313,317,318,320,326,333,338,347,399,663,957,1190],$Vbr=[2,1039],$Vcr=[1,4918],$Vdr=[1,4919],$Ver=[1,4920],$Vfr=[2,1015],$Vgr=[2,6,10,19,170,176,206,242,266,294,308,310,313,317,318,320,325,326,333,338,347,399,656,663,957,1190],$Vhr=[1,4924],$Vir=[1,4925],$Vjr=[2,6,10,242,266,294,308,313,317,318,320,326,333,338,347,399,663,1190],$Vkr=[6,10,242,320,347,399,663,957,1190],$Vlr=[1,4939],$Vmr=[1,4940],$Vnr=[1,4941],$Vor=[170,176,242,320,656,663],$Vpr=[2,6,10,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,160,161,167,170,176,183,184,194,206,209,231,242,246,266,283,286,287,288,294,300,301,302,307,308,309,310,313,317,318,320,325,326,333,338,343,347,350,351,352,385,386,394,399,402,445,571,577,656,663,668,1190],$Vqr=[1,4985],$Vrr=[2,6,10,19,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,160,161,167,170,176,183,184,194,206,209,231,242,246,250,266,283,286,287,288,294,300,301,302,307,308,309,310,313,317,318,320,325,326,331,333,336,338,343,347,350,351,352,385,386,394,399,402,445,571,577,583,656,663,668,957,1190],$Vsr=[2,1108],$Vtr=[2,1679],$Vur=[2,1487],$Vvr=[1,5006],$Vwr=[1,5005],$Vxr=[1,5003],$Vyr=[1,5027],$Vzr=[1,5032],$VAr=[2,1751],$VBr=[19,207,281,304,346,348,382,383,395,403,404],$VCr=[1,5046],$VDr=[1,5050],$VEr=[1,5052],$VFr=[6,10,38,40,73,75,117,121,167,212,243,244,274,275,286,321,323,352,452,543,577,1190],$VGr=[2,1801],$VHr=[2,1875],$VIr=[2,2184],$VJr=[2,6,10,19,29,35,40,63,105,152,153,154,155,249,322,323,394,399,452],$VKr=[2,6,10,29,35,40,63,105,152,153,154,155,249,322,323,394,399,452],$VLr=[1,5077],$VMr=[1,5083],$VNr=[1,5085],$VOr=[1,5089],$VPr=[1,5091],$VQr=[1,5093],$VRr=[1,5099],$VSr=[1,5101],$VTr=[1,5108],$VUr=[6,10,19,75,114,117,121,167,212,244,274,275,286,315,335,543],$VVr=[2,2170],$VWr=[2,2258],$VXr=[1,5136],$VYr=[2,2436],$VZr=[1,5138],$V_r=[6,10,40,73,75,117,121,167,212,243,244,274,275,286,321,323,352,452,543,577,1190],$V$r=[1,5143],$V0s=[19,167],$V1s=[2,2802],$V2s=[2,1619],$V3s=[2,19,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,160,161,167,402],$V4s=[2,6,10,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,160,161,170,176,184,206,231,242,309,310,320,325,347,351,399,402,445,577,656,663,1190],$V5s=[2,2068],$V6s=[1,5191],$V7s=[2,2065],$V8s=[1,5194],$V9s=[2,2905],$Vas=[2,2909],$Vbs=[1,5207],$Vcs=[2,1703],$Vds=[2,1701],$Ves=[6,10,19,37,75,114,117,121,167,212,244,274,275,286,335,543,957],$Vfs=[2,2313],$Vgs=[6,10,37,75,114,117,121,167,212,244,274,275,286,335,543],$Vhs=[1,5221],$Vis=[1,5248],$Vjs=[1,5253],$Vks=[2,2550],$Vls=[6,10,278],$Vms=[1,5265],$Vns=[2,6,10,266,294,308,313,317,318,326,333,338,347,399,663,957,1190],$Vos=[2,1070],$Vps=[1,5274],$Vqs=[1,5273],$Vrs=[2,1040],$Vss=[2,6,10,19,242,266,294,308,313,317,318,320,326,333,338,347,399,663,957,1190],$Vts=[2,1042],$Vus=[2,1003],$Vvs=[2,6,10,266,294,308,313,317,318,326,333,338,347,399,663,1190],$Vws=[6,10,347,399,663,957,1190],$Vxs=[1,5294],$Vys=[1,5293],$Vzs=[2,6,10,19,242,320,347,399,663,957,1190],$VAs=[242,320,663],$VBs=[2,6,10,170,176,183,206,242,266,294,308,310,313,317,318,320,325,326,333,338,347,352,394,399,656,663,1190],$VCs=[2,1107],$VDs=[2,1096],$VEs=[1,5351],$VFs=[19,288,785],$VGs=[19,288,398,785],$VHs=[2,1478],$VIs=[1,5365],$VJs=[1,5372],$VKs=[6,10,40,75,117,121,167,212,244,274,275,286,323,352,452,543,577,1190],$VLs=[1,5383],$VMs=[1,5382],$VNs=[1,5388],$VOs=[1,5389],$VPs=[2,389,394],$VQs=[1,5394],$VRs=[2,19,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,160,161,168,175,251,285,289,290,293,297,299,305,314,321,340,341,344,345,349,389,394,402,441],$VSs=[1,5395],$VTs=[1,5396],$VUs=[1,5403],$VVs=[1,5404],$VWs=[1,5401],$VXs=[1,5402],$VYs=[6,10,19,75,114,117,121,167,212,244,274,275,286,335,543,957],$VZs=[1,5405],$V_s=[2,1030],$V$s=[1,5411],$V0t=[1,5410],$V1t=[1,5412],$V2t=[1,5413],$V3t=[1,5416],$V4t=[1,5418],$V5t=[1,5424],$V6t=[1,5426],$V7t=[2,2441],$V8t=[1,5430],$V9t=[6,10,40,73,75,117,121,167,212,243,244,274,275,286,323,352,452,543,577,1190],$Vat=[1,5441],$Vbt=[1,5443],$Vct=[19,399],$Vdt=[2,1387],$Vet=[1,5457],$Vft=[2,1635],$Vgt=[2,2347],$Vht=[2,2590],$Vit=[6,10,19,40,69,75,117,121,244,274,275,312,335,452],$Vjt=[2,2619],$Vkt=[6,10,40,69,75,117,121,244,274,275,312,335,452],$Vlt=[1,5508],$Vmt=[6,10,40,69,75,117,121,244,274,275,312,335,352,452],$Vnt=[1,5523],$Vot=[2,6,10,266,294,308,313,317,318,326,333,338,347,399,957,1190],$Vpt=[2,1080],$Vqt=[1,5533],$Vrt=[2,1071],$Vst=[1,5535],$Vtt=[2,1016],$Vut=[1,5542],$Vvt=[2,6,10,19,170,176,242,250,266,294,308,313,317,318,320,326,331,333,336,338,347,394,399,656,663,957,1190],$Vwt=[2,991],$Vxt=[1,5546],$Vyt=[2,6,10,266,294,308,313,317,318,326,333,338,347,399,1190],$Vzt=[6,10,347,399,957,1190],$VAt=[2,6,10,170,176,242,246,266,294,308,313,317,318,320,326,333,338,347,394,399,656,663,1190],$VBt=[1,5609],$VCt=[1,5624],$VDt=[2,144,174,295,382,385,399,785],$VEt=[2,1497],$VFt=[19,144,174,295,382,385,399,785],$VGt=[2,2431],$VHt=[1,5640],$VIt=[1,5641],$VJt=[2,2369],$VKt=[2,6,10,19,170,176,242,246,250,266,294,308,313,317,318,320,326,331,333,336,338,347,394,399,656,663,957,1190],$VLt=[1,5683],$VMt=[2,3122],$VNt=[6,10,19,75,117,121,167,212,244,274,275,286,335,543,957],$VOt=[2,2373],$VPt=[6,10,75,117,121,167,212,244,274,275,286,335,543],$VQt=[1,5710],$VRt=[6,10,19,40,75,117,121,244,274,275,312,335,452],$VSt=[2,2623],$VTt=[1,5725],$VUt=[6,10,40,75,117,121,244,274,275,312,335,452],$VVt=[1,5740],$VWt=[2,6,10,19,266,294,308,313,317,318,326,333,338,347,399,663,957,1190],$VXt=[2,1076],$VYt=[2,1050],$VZt=[2,1054],$V_t=[2,1058],$V$t=[1,5756],$V0u=[2,6,10,19,242,266,294,308,313,317,318,320,326,333,338,347,394,399,663,957,1190],$V1u=[2,1035],$V2u=[1,5760],$V3u=[1,5762],$V4u=[1,5761],$V5u=[1,5764],$V6u=[2,6,10,242,266,294,308,313,317,318,320,326,333,338,347,394,399,663,1190],$V7u=[1,5780],$V8u=[2,6,10,170,176,242,266,294,308,313,317,318,320,326,333,338,347,394,399,656,663,1190],$V9u=[1,5807],$Vau=[2,385,399],$Vbu=[2,1507],$Vcu=[1,5830],$Vdu=[1,5829],$Veu=[1,5828],$Vfu=[1,5826],$Vgu=[1,5827],$Vhu=[19,385,399],$Viu=[1,5840],$Vju=[1,5859],$Vku=[2,2450],$Vlu=[1,5863],$Vmu=[1,5865],$Vnu=[6,10,40,75,117,121,167,212,244,274,275,286,352,452,543,577,1190],$Vou=[2,1388],$Vpu=[2,2382],$Vqu=[1,5895],$Vru=[1,5893],$Vsu=[6,10,75,121,167,212,244,275,286,543],$Vtu=[1,5897],$Vuu=[1,5912],$Vvu=[6,10,19,40,75,117,121,244,274,275,335,452],$Vwu=[2,2625],$Vxu=[6,10,40,75,117,121,244,274,275,335,452],$Vyu=[1,5921],$Vzu=[1,5922],$VAu=[6,10,19,214,225,235,257],$VBu=[2,2557],$VCu=[6,10,214,225,235,257],$VDu=[1,5932],$VEu=[2,1082],$VFu=[1,5947],$VGu=[1,5948],$VHu=[1,5950],$VIu=[2,3116],$VJu=[2,1517],$VKu=[1,5965],$VLu=[1,5966],$VMu=[1,5967],$VNu=[19,306,329],$VOu=[19,335],$VPu=[1,5977],$VQu=[6,10,19,40,75,117,121,167,212,244,274,275,286,352,452,543,577,957,1190,1209],$VRu=[1,5985],$VSu=[6,10,121,167,212,275,286,543],$VTu=[6,10,19,40,75,121,167,212,244,275,286,452,543,957],$VUu=[1,6002],$VVu=[1,6003],$VWu=[1,6020],$VXu=[1,6021],$VYu=[1,6026],$VZu=[1,6027],$V_u=[6,10,40,75,121,244,275,452],$V$u=[6,10,19,225,235,257],$V0v=[2,2560],$V1v=[6,10,225,235,257],$V2v=[1,6042],$V3v=[2,1489],$V4v=[2,19,385,399],$V5v=[2,2286],$V6v=[1,6065],$V7v=[1,6066],$V8v=[1,6067],$V9v=[2,2460],$Vav=[6,10,167,212,286,543],$Vbv=[1,6089],$Vcv=[19,50,110,219],$Vdv=[1,6094],$Vev=[1,6099],$Vfv=[1,6103],$Vgv=[1,6112],$Vhv=[6,10,40,121,275,452],$Viv=[6,10,19,225,235],$Vjv=[2,2563],$Vkv=[6,10,225,235],$Vlv=[1,6131],$Vmv=[1,6147],$Vnv=[1,6148],$Vov=[2,2276],$Vpv=[1,6151],$Vqv=[2,6,10,19,399],$Vrv=[6,10,19,40,167,212,286,452,543,957],$Vsv=[1,6187],$Vtv=[1,6188],$Vuv=[6,10,40,452],$Vvv=[6,10,19,235],$Vwv=[2,2566],$Vxv=[6,10,235],$Vyv=[1,6208],$Vzv=[2,19,399],$VAv=[6,10,957],$VBv=[2,2465],$VCv=[2,2345],$VDv=[2,2346],$VEv=[2,2569],$VFv=[1,6267],$VGv=[2,2469],$VHv=[2,2330],$VIv=[2,2329],$VJv=[2,2599],$VKv=[2,2501],$VLv=[2,2328];
var parser = {trace: function trace() { },
yy: {},
symbols_: {"error":2,"SqlSyntax":3,"NewStatement":4,"SqlStatements":5,"EOF":6,"SqlAutocomplete":7,"SqlStatements_EDIT":8,"SqlStatement":9,";":10,"NonStartingToken":11,"SqlStatement_EDIT":12,"DataDefinition":13,"DataManipulation":14,"QuerySpecification":15,"ExplainClause":16,"AnyCursor":17,"CommonTableExpression":18,"CURSOR":19,"ExplainClause_EDIT":20,"DataDefinition_EDIT":21,"DataManipulation_EDIT":22,"QuerySpecification_EDIT":23,"SetSpecification_EDIT":24,"NonReservedKeyword":25,"<hive>ABORT":26,"<hive>ADD":27,"<hive>ADMIN":28,"<hive>AFTER":29,"<hive>ANALYZE":30,"<hive>ARCHIVE":31,"<hive>AVRO":32,"<hive>BUCKET":33,"<hive>BUCKETS":34,"<hive>CASCADE":35,"<hive>CHANGE":36,"<hive>CLUSTERED":37,"<hive>COLLECTION":38,"<hive>COLUMNS":39,"<hive>COMMENT":40,"<hive>COMPACT":41,"<hive>COMPACTIONS":42,"<hive>COMPUTE":43,"<hive>CONCATENATE":44,"<hive>DATA":45,"<hive>DATABASES":46,"<hive>DBPROPERTIES":47,"<hive>DEFERRED":48,"<hive>DEFINED":49,"<hive>DELIMITED":50,"<hive>DEPENDENCY":51,"<hive>DIRECTORY":52,"<hive>DISABLE":53,"<hive>DOUBLE_PRECISION":54,"<hive>ENABLE":55,"<hive>ESCAPED":56,"<hive>EXCHANGE":57,"<hive>EXPLAIN":58,"<hive>EXPORT":59,"<hive>FIELDS":60,"<hive>FILE":61,"<hive>FILEFORMAT":62,"<hive>FIRST":63,"<hive>FORMAT":64,"<hive>FUNCTIONS":65,"<hive>INPATH":66,"<hive>INPUTFORMAT":67,"<hive>JAR":68,"<hive>IDXPROPERTIES":69,"<hive>ITEMS":70,"<hive>KEY":71,"<hive>KEYS":72,"<hive>LINES":73,"<hive>LOAD":74,"<hive>LOCATION":75,"<hive>LOCKS":76,"<hive>MATCHED":77,"<hive>METADATA":78,"<hive>MERGE":79,"<hive>MSCK":80,"<hive>NOSCAN":81,"<hive>NOVALIDATE":82,"<hive>NO_DROP":83,"<hive>OFFLINE":84,"<hive>ORC":85,"<hive>OUTPUTFORMAT":86,"<hive>OVERWRITE":87,"<hive>OWNER":88,"<hive>PARQUET":89,"<hive>PARTITIONED":90,"<hive>PARTITIONS":91,"<hive>PERCENT":92,"<hive>PRIVILEGES":93,"<hive>PURGE":94,"<hive>RCFILE":95,"<hive>REBUILD":96,"<hive>RELOAD":97,"<hive>RELY":98,"<hive>NORELY":99,"<hive>REPAIR":100,"<hive>REPLICATION":101,"<hive>RECOVER":102,"<hive>RENAME":103,"<hive>REPLACE":104,"<hive>RESTRICT":105,"<hive>ROLE":106,"<hive>ROLES":107,"<hive>SCHEMAS":108,"<hive>SEQUENCEFILE":109,"<hive>SERDE":110,"<hive>SERDEPROPERTIES":111,"<hive>SETS":112,"<hive>SHOW":113,"<hive>SKEWED":114,"<hive>SORTED":115,"<hive>STATISTICS":116,"<hive>STORED":117,"<hive>STRING":118,"STRUCT":119,"<hive>TABLES":120,"<hive>TBLPROPERTIES":121,"<hive>TEMPORARY":122,"<hive>TERMINATED":123,"<hive>TEXTFILE":124,"<hive>TIMESTAMP":125,"<hive>TINYINT":126,"<hive>TOUCH":127,"<hive>TRANSACTIONS":128,"<hive>UNARCHIVE":129,"<hive>UNIONTYPE":130,"<hive>USE":131,"<hive>USER":132,"<hive>VIEW":133,"<hive>WAIT":134,"<hive>DAY":135,"<hive>HOUR":136,"<hive>MINUTE":137,"<hive>MONTH":138,"<hive>QUARTER":139,"<hive>SECOND":140,"<hive>WEEK":141,"<hive>YEAR":142,"<impala>ANALYTIC":143,"<impala>CURRENT":144,"<impala>GRANT":145,"<impala>RECOVER":146,"<impala>ROLE":147,"<impala>ROLES":148,"<impala>URI":149,"<impala>SERVER":150,"<impala>UNKNOWN":151,"<impala>BLOCK_SIZE":152,"<impala>COMPRESSION":153,"<impala>DEFAULT":154,"<impala>ENCODING":155,"<impala>KEY":156,"ROLE":157,"OPTION":158,"RegularIdentifier":159,"REGULAR_IDENTIFIER":160,"VARIABLE_REFERENCE":161,"OptionalHiveExplainTypes":162,"<impala>EXPLAIN":163,"<hive>AUTHORIZATION":164,"<hive>EXTENDED":165,"<hive>ALL":166,"<hive>AS":167,"<hive>BINARY":168,"<hive>CACHE":169,"<hive>CLUSTER":170,"<hive>CONF":171,"<hive>CONSTRAINT":172,"<hive>CUBE":173,"<hive>CURRENT":174,"<hive>DATE":175,"<hive>DISTRIBUTE":176,"<hive>DISTRIBUTED":177,"<hive>EXTERNAL":178,"<hive>FOR":179,"<hive>FOREIGN":180,"<hive>FUNCTION":181,"<hive>GRANT":182,"<hive>GROUPING":183,"<hive>LATERAL":184,"<hive>LOCAL":185,"<hive>LOCK":186,"<hive>MACRO":187,"<hive>PARTITION":188,"<hive>PRIMARY":189,"<hive>REFERENCES":190,"<hive>ROLLUP":191,"<hive>SHOW_DATABASE":192,"<hive>TABLE":193,"<hive>ASC":194,"<hive>FORMATTED":195,"<hive>INDEX":196,"<hive>INDEXES":197,"<hive>NONE":198,"<hive>OF":199,"<hive>OUT":200,"<hive>SCHEMA":201,"<hive>STORED_AS_DIRECTORIES":202,"<hive>TABLESAMPLE":203,"<hive>USING":204,"<hive>VIEWS":205,"<hive>WINDOW":206,"<hive>.":207,"<hive>[":208,"<hive>]":209,"<impala>AGGREGATE":210,"<impala>AVRO":211,"<impala>CACHED":212,"<impala>CASCADE":213,"<impala>CLOSE_FN":214,"<impala>COLUMN":215,"<impala>DATA":216,"<impala>DATABASES":217,"<impala>DELETE":218,"<impala>DELIMITED":219,"<impala>ESCAPED":220,"<impala>EXTENDED":221,"<impala>EXTERNAL":222,"<impala>FIELDS":223,"<impala>FILES":224,"<impala>FINALIZE_FN":225,"<impala>FIRST":226,"<impala>FORMAT":227,"<impala>FORMATTED":228,"<impala>FUNCTION":229,"<impala>FUNCTIONS":230,"<impala>GROUP":231,"<impala>HASH":232,"<impala>ILIKE":233,"<impala>INCREMENTAL":234,"<impala>INTERMEDIATE":235,"<impala>INTERVAL":236,"<impala>INIT_FN":237,"<impala>INPATH":238,"<impala>IREGEXP":239,"<impala>KUDU":240,"<impala>LAST":241,"<impala>LIMIT":242,"<impala>LINES":243,"<impala>LOCATION":244,"<impala>MERGE_FN":245,"<impala>NULLS":246,"<impala>PARTITIONS":247,"<impala>PREPARE_FN":248,"<impala>PRIMARY":249,"<impala>RANGE":250,"<impala>REAL":251,"<impala>REPEATABLE":252,"<impala>REPLICATION":253,"<impala>RESTRICT":254,"<impala>RETURNS":255,"<impala>SCHEMAS":256,"<impala>SERIALIZE_FN":257,"<impala>SORT":258,"<impala>STATS":259,"<impala>STRAIGHT_JOIN":260,"<impala>SYMBOL":261,"<impala>TABLE":262,"<impala>TABLES":263,"<impala>TABLESAMPLE":264,"<impala>USING":265,"<impala>ANTI":266,"<impala>NOSHUFFLE":267,"<impala>PARQUET":268,"<impala>PARTITIONED":269,"<impala>RCFILE":270,"<impala>SEQUENCEFILE":271,"<impala>SERDEPROPERTIES":272,"<impala>SHUFFLE":273,"<impala>STORED":274,"<impala>TBLPROPERTIES":275,"<impala>TERMINATED":276,"<impala>TEXTFILE":277,"<impala>UPDATE_FN":278,"<impala>BROADCAST":279,"<impala>...":280,"<impala>.":281,"<impala>[":282,"<impala>]":283,"ALL":284,"ARRAY":285,"AS":286,"ASC":287,"BETWEEN":288,"BIGINT":289,"BOOLEAN":290,"BY":291,"CASE":292,"CHAR":293,"CROSS":294,"CURRENT":295,"DATABASE":296,"DECIMAL":297,"DISTINCT":298,"DOUBLE":299,"DESC":300,"ELSE":301,"END":302,"EXISTS":303,"FALSE":304,"FLOAT":305,"FOLLOWING":306,"FROM":307,"FULL":308,"GROUP":309,"HAVING":310,"IF":311,"IN":312,"INNER":313,"INT":314,"INTO":315,"IS":316,"JOIN":317,"LEFT":318,"LIKE":319,"LIMIT":320,"MAP":321,"NOT":322,"NULL":323,"ON":324,"ORDER":325,"OUTER":326,"OVER":327,"PARTITION":328,"PRECEDING":329,"PURGE":330,"RANGE":331,"REGEXP":332,"RIGHT":333,"RLIKE":334,"ROW":335,"ROWS":336,"SCHEMA":337,"SEMI":338,"SET":339,"SMALLINT":340,"STRING":341,"TABLE":342,"THEN":343,"TIMESTAMP":344,"TINYINT":345,"TRUE":346,"UNION":347,"VALUES":348,"VARCHAR":349,"WHEN":350,"WHERE":351,"WITH":352,"AVG":353,"CAST":354,"COUNT":355,"MAX":356,"MIN":357,"STDDEV_POP":358,"STDDEV_SAMP":359,"SUM":360,"VARIANCE":361,"VAR_POP":362,"VAR_SAMP":363,"<hive>COLLECT_SET":364,"<hive>COLLECT_LIST":365,"<hive>CORR":366,"<hive>COVAR_POP":367,"<hive>COVAR_SAMP":368,"<hive>DAYOFWEEK":369,"<hive>HISTOGRAM_NUMERIC":370,"<hive>NTILE":371,"<hive>PERCENTILE":372,"<hive>PERCENTILE_APPROX":373,"<impala>APPX_MEDIAN":374,"<impala>EXTRACT":375,"<impala>GROUP_CONCAT":376,"<impala>NDV":377,"<impala>STDDEV":378,"<impala>VARIANCE_POP":379,"<impala>VARIANCE_SAMP":380,"ANALYTIC":381,"UNSIGNED_INTEGER":382,"UNSIGNED_INTEGER_E":383,"HDFS_START_QUOTE":384,"AND":385,"OR":386,"=":387,"<":388,">":389,"COMPARISON_OPERATOR":390,"-":391,"*":392,"ARITHMETIC_OPERATOR":393,",":394,".":395,"~":396,"!":397,"(":398,")":399,"[":400,"]":401,"BACKTICK":402,"SINGLE_QUOTE":403,"DOUBLE_QUOTE":404,"DescribeStatement":405,"AlterStatement":406,"AnalyzeStatement":407,"RefreshStatement":408,"InvalidateStatement":409,"ComputeStatsStatement":410,"CreateStatement":411,"DropStatement":412,"HiveAbortStatement":413,"GrantStatement":414,"RevokeStatement":415,"SetRoleStatement":416,"SetSpecification":417,"ShowStatement":418,"UseStatement":419,"DescribeStatement_EDIT":420,"AlterStatement_EDIT":421,"AnalyzeStatement_EDIT":422,"RefreshStatement_EDIT":423,"InvalidateStatement_EDIT":424,"ComputeStatsStatement_EDIT":425,"CreateStatement_EDIT":426,"DropStatement_EDIT":427,"HiveAbortStatement_EDIT":428,"GrantStatement_EDIT":429,"RevokeStatement_EDIT":430,"SetRoleStatement_EDIT":431,"ShowStatement_EDIT":432,"UseStatement_EDIT":433,"AggregateOrAnalytic":434,"Commas":435,"AnyAs":436,"AnyCreate":437,"CREATE":438,"<hive>CREATE":439,"<impala>CREATE":440,"PARTIAL_CURSOR":441,"AnyDot":442,"AnyFromOrIn":443,"AnyGroup":444,"<hive>GROUP":445,"AnyPartition":446,"AnyTable":447,"DatabaseOrSchema":448,"FromOrIn":449,"HiveIndexOrIndexes":450,"HiveOrImpalaComment":451,"<impala>COMMENT":452,"HiveOrImpalaCreate":453,"HiveOrImpalaDatabasesOrSchemas":454,"HiveOrImpalaEscaped":455,"HiveOrImpalaFields":456,"HiveOrImpalaFormat":457,"HiveOrImpalaLeftSquareBracket":458,"HiveOrImpalaLines":459,"HiveOrImpalaLocation":460,"HiveOrImpalaRightSquareBracket":461,"HiveOrImpalaPartitioned":462,"HiveOrImpalaStored":463,"HiveOrImpalaTables":464,"HiveOrImpalaTblproperties":465,"HiveOrImpalaTerminated":466,"HiveRoleOrUser":467,"SingleQuotedValue":468,"VALUE":469,"SingleQuotedValue_EDIT":470,"PARTIAL_VALUE":471,"DoubleQuotedValue":472,"DoubleQuotedValue_EDIT":473,"QuotedValue":474,"QuotedValue_EDIT":475,"OptionalAggregateOrAnalytic":476,"OptionalHiveExtended":477,"OptionalHiveExtendedOrFormatted":478,"OptionalExternal":479,"OptionalImpalaExtendedOrFormatted":480,"OptionallyFormattedIndex":481,"OptionallyFormattedIndex_EDIT":482,"OptionalFromDatabase":483,"DatabaseIdentifier":484,"OptionalFromDatabase_EDIT":485,"DatabaseIdentifier_EDIT":486,"OptionalCascade":487,"OptionalCascadeOrRestrict":488,"OptionalHiveCascadeOrRestrict":489,"OptionalHiveTemporary":490,"OptionalIfExists":491,"OptionalIfExists_EDIT":492,"OptionalIfNotExists":493,"OptionalIfNotExists_EDIT":494,"OptionalInDatabase":495,"OptionalPartitionSpec":496,"PartitionSpec":497,"OptionalPartitionSpec_EDIT":498,"PartitionSpec_EDIT":499,"PartitionSpecList":500,"PartitionSpecList_EDIT":501,"RightParenthesisOrError":502,"RangePartitionSpec":503,"UnsignedValueSpecification":504,"RangePartitionComparisonOperator":505,"RangePartitionSpec_EDIT":506,"ConfigurationName":507,"PartialBacktickedOrAnyCursor":508,"PartialBacktickedIdentifier":509,"PartialBacktickedOrCursor":510,"PartialBacktickedOrPartialCursor":511,"OptionalParenthesizedColumnList":512,"ParenthesizedColumnList":513,"OptionalParenthesizedColumnList_EDIT":514,"ParenthesizedColumnList_EDIT":515,"ColumnList":516,"ColumnList_EDIT":517,"ColumnIdentifier":518,"ColumnIdentifier_EDIT":519,"ParenthesizedSimpleValueList":520,"SimpleValueList":521,"SchemaQualifiedTableIdentifier":522,"RegularOrBacktickedIdentifier":523,"ImpalaFields":524,"SchemaQualifiedTableIdentifier_EDIT":525,"ImpalaFields_EDIT":526,"ImpalaField":527,"ImpalaField_EDIT":528,"SchemaQualifiedIdentifier":529,"SchemaQualifiedIdentifier_EDIT":530,"PartitionExpression":531,"PartitionExpression_EDIT":532,"ValueExpression":533,"ValueExpression_EDIT":534,"OptionalHdfsLocation":535,"HdfsLocation":536,"HdfsPath":537,"HdfsLocation_EDIT":538,"HdfsPath_EDIT":539,"OptionalCachedInOrUncached":540,"CachedIn":541,"OptionalWithReplication":542,"<impala>UNCACHED":543,"OptionalCachedIn":544,"CachedIn_EDIT":545,"WithReplication":546,"SignedInteger":547,"WithReplication_EDIT":548,"RegularOrBackTickedSchemaQualifiedName":549,"RegularOrBackTickedSchemaQualifiedName_EDIT":550,"LocalOrSchemaQualifiedName":551,"LocalOrSchemaQualifiedName_EDIT":552,"ColumnReference":553,"BasicIdentifierChain":554,"ColumnReference_EDIT":555,"BasicIdentifierChain_EDIT":556,"DerivedColumnChain":557,"DerivedColumnChain_EDIT":558,"PartialBacktickedIdentifierOrPartialCursor":559,"HiveOrImpalaRightSquareBracketOrError":560,"PrimitiveType":561,"OptionalTypePrecision":562,"OptionalTypeLength":563,"HiveDescribeStatement":564,"ImpalaDescribeStatement":565,"HiveDescribeStatement_EDIT":566,"ImpalaDescribeStatement_EDIT":567,"HiveDesc":568,"<impala>DESCRIBE":569,"<hive>DESCRIBE":570,"<hive>DESC":571,"SelectStatement":572,"OptionalUnions":573,"SelectStatement_EDIT":574,"OptionalUnions_EDIT":575,"CommonTableExpression_EDIT":576,"SELECT":577,"OptionalAllOrDistinct":578,"OptionalStraightJoin":579,"SelectList":580,"TableExpression":581,"SelectList_ERROR":582,"TableExpression_ERROR":583,"Unions":584,"Unions_EDIT":585,"UnionClause":586,"UnionClause_EDIT":587,"SelectList_EDIT":588,"TableExpression_EDIT":589,"SelectList_ERROR_EDIT":590,"WithQueries":591,"WithQueries_EDIT":592,"WithQuery":593,"WithQuery_EDIT":594,"TableSubQueryInner":595,"TableSubQueryInner_EDIT":596,"FromClause":597,"OptionalSelectConditions":598,"FromClause_EDIT":599,"OptionalJoins":600,"OptionalSelectConditions_EDIT":601,"Joins":602,"Joins_INVALID":603,"TableReferenceList":604,"OptionalLateralViews":605,"TableReferenceList_EDIT":606,"OptionalLateralViews_EDIT":607,"OptionalWhereClause":608,"OptionalGroupByClause":609,"OptionalHavingClause":610,"OptionalWindowClause":611,"OptionalOrderByClause":612,"OptionalClusterOrDistributeBy":613,"OptionalLimitClause":614,"OptionalOffsetClause":615,"WhereClause_EDIT":616,"GroupByClause_EDIT":617,"HavingClause_EDIT":618,"WindowClause_EDIT":619,"OrderByClause_EDIT":620,"ClusterOrDistributeBy_EDIT":621,"LimitClause_EDIT":622,"OffsetClause_EDIT":623,"WhereClause":624,"GroupByClause":625,"HavingClause":626,"WindowClause":627,"OrderByClause":628,"ClusterOrDistributeBy":629,"LimitClause":630,"SearchCondition":631,"SearchCondition_EDIT":632,"GroupByColumnList":633,"OptionalHiveGroupingSetsCubeOrRollup":634,"GroupByColumnList_EDIT":635,"OptionalHiveGroupingSetsCubeOrRollup_EDIT":636,"HiveGroupingSets":637,"HiveGroupingSets_EDIT":638,"ColumnGroupingSets":639,"ColumnGroupingSets_EDIT":640,"ColumnGroupingSet_EDIT":641,"GroupByColumnListPartTwo_EDIT":642,"OrderByColumnList":643,"OrderByColumnList_EDIT":644,"OrderByIdentifier":645,"OrderByIdentifier_EDIT":646,"OptionalAscOrDesc":647,"OptionalImpalaNullsFirstOrLast":648,"OptionalImpalaNullsFirstOrLast_EDIT":649,"ClusterByClause":650,"DistributeByClause":651,"SortByClause":652,"ClusterByClause_EDIT":653,"DistributeByClause_EDIT":654,"SortByClause_EDIT":655,"<hive>SORT":656,"SortByList":657,"SortByList_EDIT":658,"SortByIdentifier":659,"SortByIdentifier_EDIT":660,"UnsignedNumericLiteral":661,"OffsetClause":662,"<impala>OFFSET":663,"NonParenthesizedValueExpressionPrimary":664,"OptionalNot":665,"TableSubQuery":666,"ValueExpressionList":667,"BETWEEN_AND":668,"LikeRightPart":669,"CaseRightPart":670,"NonParenthesizedValueExpressionPrimary_EDIT":671,"TableSubQuery_EDIT":672,"ValueExpressionInSecondPart_EDIT":673,"LikeRightPart_EDIT":674,"CaseRightPart_EDIT":675,"EndOrError":676,"ValueExpressionList_EDIT":677,"InValueList":678,"ColumnOrArbitraryFunctionRef":679,"ArbitraryFunctionRightPart":680,"ArbitraryFunctionName":681,"UserDefinedFunction":682,"ImpalaInterval":683,"UnsignedValueSpecification_EDIT":684,"ColumnOrArbitraryFunctionRef_EDIT":685,"ArbitraryFunctionRightPart_EDIT":686,"UserDefinedFunction_EDIT":687,"ImpalaInterval_EDIT":688,"+":689,"UnsignedLiteral":690,"UnsignedLiteral_EDIT":691,"GeneralLiteral":692,"GeneralLiteral_EDIT":693,"ExactNumericLiteral":694,"ApproximateNumericLiteral":695,"TruthValue":696,"SelectSpecification":697,"OptionalCorrelationName":698,"SelectSpecification_EDIT":699,"OptionalCorrelationName_EDIT":700,"TableReference":701,"TableReference_EDIT":702,"TablePrimaryOrJoinedTable":703,"TablePrimaryOrJoinedTable_EDIT":704,"TablePrimary":705,"JoinedTable":706,"TablePrimary_EDIT":707,"JoinedTable_EDIT":708,"Joins_EDIT":709,"JoinType":710,"OptionalImpalaBroadcastOrShuffle":711,"OptionalJoinCondition":712,"Join_EDIT":713,"JoinType_EDIT":714,"JoinCondition_EDIT":715,"UsingColList":716,"TableOrQueryName":717,"OptionalHiveTableSample":718,"OptionalImpalaTableSample":719,"DerivedTable":720,"TableOrQueryName_EDIT":721,"OptionalHiveTableSample_EDIT":722,"OptionalImpalaTableSample_EDIT":723,"DerivedTable_EDIT":724,"OptionalOnColumn":725,"OptionalOnColumn_EDIT":726,"<impala>SYSTEM":727,"PushQueryState":728,"PopQueryState":729,"SubQuery":730,"SubQuery_EDIT":731,"QueryExpression":732,"QueryExpression_EDIT":733,"QueryExpressionBody":734,"QueryExpressionBody_EDIT":735,"NonJoinQueryExpression":736,"NonJoinQueryExpression_EDIT":737,"NonJoinQueryTerm":738,"NonJoinQueryTerm_EDIT":739,"NonJoinQueryPrimary":740,"NonJoinQueryPrimary_EDIT":741,"SimpleTable":742,"SimpleTable_EDIT":743,"LateralView":744,"LateralView_EDIT":745,"AggregateFunction":746,"OptionalOverClause":747,"AnalyticFunction":748,"OverClause":749,"CastFunction":750,"HiveExtractFunction":751,"ImpalaExtractFunction":752,"AggregateFunction_EDIT":753,"OptionalOverClause_EDIT":754,"AnalyticFunction_EDIT":755,"OverClause_EDIT":756,"CastFunction_EDIT":757,"HiveExtractFunction_EDIT":758,"ImpalaExtractFunction_EDIT":759,"ArbitraryFunction":760,"ArbitraryFunction_EDIT":761,"<impala>REPLACE":762,"TRUNCATE":763,"OptionalFunctionSquareBracket":764,"CountFunction":765,"SumFunction":766,"OtherAggregateFunction":767,"CountFunction_EDIT":768,"SumFunction_EDIT":769,"OtherAggregateFunction_EDIT":770,"WindowExpression":771,"WindowExpression_EDIT":772,"OptionalPartitionBy":773,"OptionalOrderByAndWindow":774,"PartitionBy_EDIT":775,"OptionalOrderByAndWindow_EDIT":776,"PartitionBy":777,"OptionalWindowSpec":778,"WindowSpec_EDIT":779,"WindowSpec":780,"RowsOrRange":781,"PopLexerState":782,"OptionalCurrentOrPreceding":783,"OptionalAndFollowing":784,"UNBOUNDED":785,"OptionalCurrentOrPreceding_EDIT":786,"OptionalAndFollowing_EDIT":787,"PushHdfsLexerState":788,"HDFS_PATH":789,"HDFS_END_QUOTE":790,"AnyRange":791,"IntegerOrUnbounded":792,"AnyCurrent":793,"<hive>EXTRACT":794,"HiveDateField":795,"OtherAggregateFunction_Type":796,"FromOrComma":797,"OptionalOuter":798,"LateralViewColumnAliases":799,"LateralViewColumnAliases_EDIT":800,"CaseWhenThenList":801,"CaseWhenThenList_EDIT":802,"CaseWhenThenListPartTwo":803,"CaseWhenThenListPartTwo_EDIT":804,"ErrorList":805,"Errors":806,"SetOption":807,"SetValue":808,"DatabaseDefinition_EDIT":809,"DatabaseDefinitionOptionals_EDIT":810,"DatabaseDefinitionOptionals":811,"AlterDatabase":812,"AlterIndex":813,"AlterTable":814,"AlterView":815,"Msck":816,"ReloadFunction":817,"CommentOn":818,"AlterDatabase_EDIT":819,"AlterIndex_EDIT":820,"AlterTable_EDIT":821,"AlterView_EDIT":822,"Msck_EDIT":823,"ReloadFunction_EDIT":824,"CommentOn_EDIT":825,"ALTER":826,"ParenthesizedPropertyAssignmentList":827,"PrincipalSpecification":828,"PrincipalSpecification_EDIT":829,"AlterTableLeftSide":830,"AnyAdd":831,"OptionalPartitionSpecs":832,"<impala>PARTITION_VALUE":833,"HivePrimaryKeySpecification":834,"HiveForeignKeySpecification":835,"AnyRename":836,"TO":837,"HiveSpecificOperations":838,"ImpalaSpecificOperations":839,"DropOperations":840,"OptionalPartitionOperations":841,"AlterTableLeftSide_EDIT":842,"AnyReplace":843,"OptionalPartitionSpecs_EDIT":844,"HivePrimaryKeySpecification_EDIT":845,"HiveForeignKeySpecification_EDIT":846,"HiveSpecificOperations_EDIT":847,"ImpalaSpecificOperations_EDIT":848,"OptionalPartitionOperations_EDIT":849,"DropOperations_EDIT":850,"AddOrReplace":851,"ClusteredBy":852,"ParenthesizedSkewedValueList":853,"OptionalStoredAsDirectories":854,"HiveExchange":855,"HiveArchiveOrUnArchive":856,"<hive>SKEWED_LOCATION":857,"ParenthesizedSkewedLocationList":858,"AnyChange":859,"<hive>COLUMN":860,"ParenthesizedColumnSpecificationList":861,"ClusteredBy_EDIT":862,"HiveExchange_EDIT":863,"ParenthesizedSkewedLocationList_EDIT":864,"OptionalStoredAsDirectories_EDIT":865,"OptionalImpalaColumn":866,"KuduStorageAttribute":867,"DROP":868,"ParenthesizedStatsList":869,"ParenthesizedStatsList_EDIT":870,"StatsList":871,"StatsList_EDIT":872,"StatsAssignment":873,"StatsAssignment_EDIT":874,"AnyFileFormat":875,"FileFormat":876,"OptionalWithSerdeproperties":877,"HiveOrImpalaSerdeproperties":878,"ImpalaRowFormat":879,"AddReplaceColumns":880,"OptionalAndWait":881,"OptionalWithOverwriteTblProperties":882,"HiveEnableOrDisable":883,"HiveNoDropOrOffline":884,"OptionalHiveColumn":885,"ColumnSpecification":886,"OptionalHiveFirstOrAfter":887,"AddReplaceColumns_EDIT":888,"ColumnSpecification_EDIT":889,"OptionalHiveFirstOrAfter_EDIT":890,"AndWait_EDIT":891,"WithOverwriteTblProperties_EDIT":892,"HiveNoDropOrOffline_EDIT":893,"ImpalaRowFormat_EDIT":894,"WithSerdeproperties_EDIT":895,"AnyColumns":896,"ParenthesizedColumnSpecificationList_EDIT":897,"<impala>COLUMNS":898,"ExchangePartitionSpec":899,"ExchangePartitionSpec_EDIT":900,"OneOrMorePartitionSpecLists":901,"OneOrMorePartitionSpecLists_EDIT":902,"OneOrMorePartitionSpecs":903,"OptionalHivePurge":904,"OneOrMorePartitionSpecs_EDIT":905,"<impala>CHANGE":906,"<impala>FILEFORMAT":907,"<impala>ADD":908,"HiveAfterOrFirst":909,"<impala>RENAME":910,"PartitionSpecWithLocationList":911,"PartitionSpecWithLocation":912,"PartitionSpecWithLocation_EDIT":913,"SkewedLocationList":914,"SkewedLocationList_EDIT":915,"SkewedLocation":916,"SkewedLocation_EDIT":917,"ColumnReferences":918,"AlterViewLeftSide":919,"AlterViewLeftSide_EDIT":920,"AnyView":921,"NullableComment":922,"OptionalForColumns":923,"OptionalCacheMetadata":924,"OptionalNoscan":925,"ForColumns":926,"CacheMetadata":927,"ForColumns_EDIT":928,"CacheMetadata_EDIT":929,"<impala>REFRESH":930,"<impala>INVALIDATE":931,"<impala>METADATA":932,"<impala>COMPUTE":933,"DatabaseDefinition":934,"TableDefinition":935,"ViewDefinition":936,"RoleDefinition":937,"FunctionDefinition":938,"IndexDefinition":939,"MacroDefinition":940,"TableDefinition_EDIT":941,"ViewDefinition_EDIT":942,"FunctionDefinition_EDIT":943,"IndexDefinition_EDIT":944,"MacroDefinition_EDIT":945,"OptionalComment":946,"OptionalHiveDbProperties":947,"OptionalComment_INVALID":948,"Comment":949,"Comment_INVALID":950,"HiveDbProperties":951,"<hive>WITH":952,"PropertyAssignmentList":953,"PropertyAssignment":954,"TableDefinitionRightPart":955,"LifeCyclePart":956,"<hive>LIFECYCLE":957,"TableDefinitionRightPart_EDIT":958,"TableIdentifierAndOptionalColumnSpecification":959,"OptionalPartitionedBy":960,"OptionalSortBy":961,"OptionalClusteredBy":962,"OptionalSkewedBy":963,"OptionalStoredAsOrBy":964,"OptionalTblproperties":965,"OptionalAsSelectStatement":966,"TableIdentifierAndOptionalColumnSpecification_EDIT":967,"PartitionedBy_EDIT":968,"SortBy_EDIT":969,"SkewedBy_EDIT":970,"StoredAsOrBy_EDIT":971,"OptionalAsSelectStatement_EDIT":972,"OptionalColumnSpecificationsOrLike":973,"OptionalColumnSpecificationsOrLike_EDIT":974,"<impala>LIKE_PARQUET":975,"ColumnSpecificationList":976,"ConstraintSpecification":977,"ColumnSpecificationList_EDIT":978,"ConstraintSpecification_EDIT":979,"ColumnDataType":980,"OptionalColumnOptions":981,"ColumnDataType_EDIT":982,"ColumnOptions_EDIT":983,"ColumnOptions":984,"ColumnOption":985,"ColumnOption_EDIT":986,"ImpalaPrimaryKey":987,"ImpalaPrimaryKey_EDIT":988,"ArrayType":989,"MapType":990,"StructType":991,"UnionType":992,"ArrayType_INVALID":993,"MapType_INVALID":994,"StructType_INVALID":995,"UnionType_INVALID":996,"ArrayType_EDIT":997,"MapType_EDIT":998,"StructType_EDIT":999,"UnionType_EDIT":1000,"GreaterThanOrError":1001,"StructDefinitionList":1002,"StructDefinitionList_EDIT":1003,"StructDefinition":1004,"StructDefinition_EDIT":1005,":":1006,"ColumnDataTypeList":1007,"ColumnDataTypeList_EDIT":1008,"ColumnDataTypeListInner_EDIT":1009,"ImpalaPrimaryKeySpecification":1010,"ImpalaPrimaryKeySpecification_EDIT":1011,"HivePrimaryKey":1012,"HivePrimaryKey_EDIT":1013,"OptionalRelyNoRely":1014,"PartitionedBy":1015,"ParenthesizedPartitionValuesList":1016,"ParenthesizedPartitionValuesList_EDIT":1017,"SortBy":1018,"PartitionValueList":1019,"PartitionValueList_EDIT":1020,"PartitionValue":1021,"PartitionValue_EDIT":1022,"LessThanOrEqualTo":1023,"OptionalHiveSortedBy":1024,"OptionalHiveSortedBy_EDIT":1025,"ParenthesizedSortList":1026,"ParenthesizedSortList_EDIT":1027,"SortList":1028,"SortList_EDIT":1029,"SortIdentifier":1030,"SortIdentifier_EDIT":1031,"SkewedBy":1032,"SkewedValueList":1033,"StoredAsOrBy":1034,"StoredAs":1035,"HiveOrImpalaRowFormat":1036,"OptionalStoredAs":1037,"StoredAs_EDIT":1038,"HiveOrImpalaRowFormat_EDIT":1039,"<impala>ORC":1040,"HiveRowFormat":1041,"HiveRowFormat_EDIT":1042,"HiveDelimitedRowFormat":1043,"HiveDelimitedRowFormat_EDIT":1044,"OptionalFieldsTerminatedBy":1045,"OptionalCollectionItemsTerminatedBy":1046,"OptionalMapKeysTerminatedBy":1047,"OptionalLinesTerminatedBy":1048,"OptionalNullDefinedAs":1049,"OptionalFieldsTerminatedBy_EDIT":1050,"OptionalCollectionItemsTerminatedBy_EDIT":1051,"OptionalMapKeysTerminatedBy_EDIT":1052,"OptionalLinesTerminatedBy_EDIT":1053,"OptionalNullDefinedAs_EDIT":1054,"ESCAPED":1055,"WithSerdeproperties":1056,"TblProperties":1057,"OptionalHiveTblproperties":1058,"CommitLocations":1059,"OptionalParenthesizedViewColumnList":1060,"ParenthesizedViewColumnList_EDIT":1061,"ImpalaFunctionDefinition":1062,"ImpalaAggregateFunctionDefinition":1063,"HiveFunctionDefinition":1064,"HiveTemporaryFunction":1065,"ImpalaFunctionDefinition_EDIT":1066,"ImpalaAggregateFunctionDefinition_EDIT":1067,"HiveFunctionDefinition_EDIT":1068,"HiveTemporaryFunction_EDIT":1069,"ParenthesizedImpalaArgumentList":1070,"ImpalaReturns":1071,"ImpalaSymbol":1072,"ParenthesizedImpalaArgumentList_EDIT":1073,"ImpalaReturns_EDIT":1074,"OptionalImpalaInitFn":1075,"ImpalaUpdateFn":1076,"ImpalaMergeFn":1077,"OptionalImpalaPrepareFn":1078,"OptionalImpalaCloseFn":1079,"OptionalImpalaSerializeFn":1080,"OptionalImpalaFinalizeFn":1081,"OptionalIntermediate":1082,"OptionalImpalaInitFn_EDIT":1083,"ImpalaUpdateFn_EDIT":1084,"ImpalaMergeFn_EDIT":1085,"OptionalImpalaPrepareFn_EDIT":1086,"OptionalImpalaCloseFn_EDIT":1087,"OptionalImpalaSerializeFn_EDIT":1088,"OptionalImpalaFinalizeFn_EDIT":1089,"Intermediate_EDIT":1090,"OptionalHiveUsing":1091,"OptionalHiveUsing_EDIT":1092,"ImpalaArgumentList":1093,"OptionalVariableArguments":1094,"ImpalaArgumentList_EDIT":1095,"FunctionReference":1096,"FunctionReference_EDIT":1097,"OneOrMoreFunctionResources":1098,"FunctionResource":1099,"FunctionResourceType":1100,"VIEW":1101,"ParenthesizedViewColumnList":1102,"ViewColumnList":1103,"ViewColumnList_EDIT":1104,"AnyRole":1105,"ExistingTable":1106,"ParenthesizedIndexColumnList":1107,"IndexType":1108,"OptionalWithDeferredRebuild":1109,"OptionalIdxProperties":1110,"OptionalInTable":1111,"ExistingTable_EDIT":1112,"ParenthesizedIndexColumnList_EDIT":1113,"IndexType_EDIT":1114,"OptionalWithDeferredRebuild_EDIT":1115,"OptionalInTable_EDIT":1116,"IndexColumnList":1117,"IndexColumnList_EDIT":1118,"MacroArguments":1119,"MacroArguments_EDIT":1120,"MacroArgumentList":1121,"MacroArgumentList_EDIT":1122,"MacroArgument":1123,"MacroArgument_EDIT":1124,"HiveDeleteStatement":1125,"ImpalaDeleteStatement":1126,"InsertStatement":1127,"LoadStatement":1128,"ImportStatement":1129,"ExportStatement":1130,"UpdateStatement":1131,"HiveDeleteStatement_EDIT":1132,"ImpalaDeleteStatement_EDIT":1133,"HiveInsertStatement_EDIT":1134,"InsertValuesStatement_EDIT":1135,"ImpalaInsertOrUpsertStatement_EDIT":1136,"HiveInsertStatement":1137,"ImpalaInsertOrUpsertStatement":1138,"HiveMergeStatement_EDIT":1139,"LoadStatement_EDIT":1140,"ImportStatement_EDIT":1141,"ExportStatement_EDIT":1142,"UpdateStatement_EDIT":1143,"DropDatabaseStatement":1144,"DropFunctionStatement":1145,"DropRoleStatement":1146,"DropStatsStatement":1147,"DropTableStatement":1148,"DropIndexStatement":1149,"DropMacroStatement":1150,"DropViewStatement":1151,"TruncateTableStatement":1152,"DropDatabaseStatement_EDIT":1153,"DropFunctionStatement_EDIT":1154,"DropStatsStatement_EDIT":1155,"DropTableStatement_EDIT":1156,"DropIndexStatement_EDIT":1157,"DropMacroStatement_EDIT":1158,"DropViewStatement_EDIT":1159,"TruncateTableStatement_EDIT":1160,"DropImpalaFunction":1161,"DropHiveFunction":1162,"DropImpalaFunction_EDIT":1163,"DropHiveFunction_EDIT":1164,"OptionalPurge":1165,"<hive>DELETE":1166,"OptionalImpalaDeleteTableRef":1167,"ImpalaDeleteTableRef_EDIT":1168,"TransactionIdList":1169,"HivePrivilegeTypeList":1170,"OptionalOnSpecification":1171,"PrincipalSpecificationList":1172,"OptionalWithGrantOption":1173,"UserOrRoleList":1174,"OptionalWithAdminOption":1175,"ImpalaPrivilegeType":1176,"ImpalaObjectSpecification":1177,"HivePrivilegeTypeList_EDIT":1178,"OnSpecification_EDIT":1179,"PrincipalSpecificationList_EDIT":1180,"WithGrantOption_EDIT":1181,"WithAdminOption_EDIT":1182,"ImpalaPrivilegeType_EDIT":1183,"ImpalaObjectSpecification_EDIT":1184,"HiveObjectSpecification":1185,"HiveObjectSpecification_EDIT":1186,"HivePrivilegeTypeWithOptionalColumn":1187,"HivePrivilegeTypeWithOptionalColumn_EDIT":1188,"HivePrivilegeType":1189,"<hive>INSERT":1190,"UPDATE":1191,"<impala>INSERT":1192,"<hive>REVOKE":1193,"PrivilegesOrGrantOption":1194,"<impala>REVOKE":1195,"PrivilegesOrGrantOption_EDIT":1196,"InsertValuesStatement":1197,"HiveMergeStatement":1198,"HiveInsertWithoutQuery":1199,"HiveInserts":1200,"SelectWithoutTableExpression":1201,"HiveInsertWithoutQuery_EDIT":1202,"HiveInserts_EDIT":1203,"SelectWithoutTableExpression_EDIT":1204,"OptionalHiveTable":1205,"OptionalInsertRowFormat":1206,"<hive>OVERWRITE_DIRECTORY":1207,"OptionalInsertRowFormat_EDIT":1208,"OptionalStoredAs_EDIT":1209,"HiveInsert":1210,"HiveInsert_EDIT":1211,"InsertValuesList":1212,"INSERT":1213,"OptionalTable":1214,"ParenthesizedRowValuesList":1215,"ImpalaInsertOrUpsertStatementWithoutCTE":1216,"ImpalaInsertOrUpsertStatementWithoutCTE_EDIT":1217,"ImpalaInsertOrUpsertLeftPart":1218,"OptionalImpalaShuffleOrNoShuffle":1219,"ImpalaRowValuesLists":1220,"ImpalaInsertOrUpsertLeftPart_EDIT":1221,"ImpalaRowValuesLists_EDIT":1222,"ImpalaUpsertStatementLeftPart":1223,"ImpalaInsertLeftPart":1224,"ImpalaUpsertStatementLeftPart_EDIT":1225,"ImpalaInsertLeftPart_EDIT":1226,"<impala>UPSERT":1227,"OptionalImpalaTable":1228,"IntoOrOverwrite":1229,"<impala>OVERWRITE":1230,"ParenthesizedImpalaRowValuesList":1231,"ParenthesizedImpalaRowValuesList_EDIT":1232,"HiveMergeStatementLeftPart":1233,"WhenList":1234,"HiveMergeStatementLeftPart_EDIT":1235,"WhenList_EDIT":1236,"MergeSource":1237,"MergeSource_EDIT":1238,"WhenClause":1239,"WhenClause_EDIT":1240,"OptionalMatchCondition":1241,"UpdateDeleteOrInsert":1242,"MatchCondition_EDIT":1243,"UpdateDeleteOrInsert_EDIT":1244,"SetClauseList":1245,"SetClauseList_EDIT":1246,"AnyLoad":1247,"AnyData":1248,"OptionalHiveLocal":1249,"AnyInpath":1250,"OptionalOverwrite":1251,"<impala>LOAD":1252,"<hive>IMPORT":1253,"OptionalTableWithPartition":1254,"TableWithPartition":1255,"TableWithPartition_EDIT":1256,"ShowColumnStatsStatement":1257,"ShowColumnsStatement":1258,"ShowCompactionsStatement":1259,"ShowConfStatement":1260,"ShowCreateTableStatement":1261,"ShowCurrentRolesStatement":1262,"ShowDatabasesStatement":1263,"ShowFilesStatement":1264,"ShowFunctionsStatement":1265,"ShowGrantStatement":1266,"ShowIndexStatement":1267,"ShowLocksStatement":1268,"ShowPartitionsStatement":1269,"ShowRoleStatement":1270,"ShowRolesStatement":1271,"ShowTableStatement":1272,"ShowTablesStatement":1273,"ShowTblPropertiesStatement":1274,"ShowTransactionsStatement":1275,"ShowViewsStatement":1276,"AnyShow":1277,"SHOW":1278,"ShowColumnStatsStatement_EDIT":1279,"ShowColumnsStatement_EDIT":1280,"ShowCreateTableStatement_EDIT":1281,"ShowCurrentRolesStatement_EDIT":1282,"ShowDatabasesStatement_EDIT":1283,"ShowFilesStatement_EDIT":1284,"ShowFunctionsStatement_EDIT":1285,"ShowGrantStatement_EDIT":1286,"ShowIndexStatement_EDIT":1287,"ShowLocksStatement_EDIT":1288,"ShowPartitionsStatement_EDIT":1289,"ShowRoleStatement_EDIT":1290,"ShowTableStatement_EDIT":1291,"ShowTablesStatement_EDIT":1292,"ShowTblPropertiesStatement_EDIT":1293,"ShowViewsStatement_EDIT":1294,"AnyTableOrView":1295,"OptionalPrincipalName":1296,"OptionalPrincipalName_EDIT":1297,"OptionalInOrFromDatabase":1298,"OptionalLike":1299,"InOrFromDatabase_EDIT":1300,"Like_EDIT":1301,"TargetTable":1302,"OptionalFromJoinedTable":1303,"TargetTable_EDIT":1304,"FromJoinedTable_EDIT":1305,"TableName":1306,"TableName_EDIT":1307,"SetClause":1308,"SetClause_EDIT":1309,"SetTarget":1310,"UpdateSource":1311,"UpdateSource_EDIT":1312,"AnyUse":1313,"USE":1314,"$accept":0,"$end":1},
terminals_: {2:"error",6:"EOF",10:";",19:"CURSOR",24:"SetSpecification_EDIT",26:"<hive>ABORT",27:"<hive>ADD",28:"<hive>ADMIN",29:"<hive>AFTER",30:"<hive>ANALYZE",31:"<hive>ARCHIVE",32:"<hive>AVRO",33:"<hive>BUCKET",34:"<hive>BUCKETS",35:"<hive>CASCADE",36:"<hive>CHANGE",37:"<hive>CLUSTERED",38:"<hive>COLLECTION",39:"<hive>COLUMNS",40:"<hive>COMMENT",41:"<hive>COMPACT",42:"<hive>COMPACTIONS",43:"<hive>COMPUTE",44:"<hive>CONCATENATE",45:"<hive>DATA",46:"<hive>DATABASES",47:"<hive>DBPROPERTIES",48:"<hive>DEFERRED",49:"<hive>DEFINED",50:"<hive>DELIMITED",51:"<hive>DEPENDENCY",52:"<hive>DIRECTORY",53:"<hive>DISABLE",54:"<hive>DOUBLE_PRECISION",55:"<hive>ENABLE",56:"<hive>ESCAPED",57:"<hive>EXCHANGE",58:"<hive>EXPLAIN",59:"<hive>EXPORT",60:"<hive>FIELDS",61:"<hive>FILE",62:"<hive>FILEFORMAT",63:"<hive>FIRST",64:"<hive>FORMAT",65:"<hive>FUNCTIONS",66:"<hive>INPATH",67:"<hive>INPUTFORMAT",68:"<hive>JAR",69:"<hive>IDXPROPERTIES",70:"<hive>ITEMS",71:"<hive>KEY",72:"<hive>KEYS",73:"<hive>LINES",74:"<hive>LOAD",75:"<hive>LOCATION",76:"<hive>LOCKS",77:"<hive>MATCHED",78:"<hive>METADATA",79:"<hive>MERGE",80:"<hive>MSCK",81:"<hive>NOSCAN",82:"<hive>NOVALIDATE",83:"<hive>NO_DROP",84:"<hive>OFFLINE",85:"<hive>ORC",86:"<hive>OUTPUTFORMAT",87:"<hive>OVERWRITE",88:"<hive>OWNER",89:"<hive>PARQUET",90:"<hive>PARTITIONED",91:"<hive>PARTITIONS",92:"<hive>PERCENT",93:"<hive>PRIVILEGES",94:"<hive>PURGE",95:"<hive>RCFILE",96:"<hive>REBUILD",97:"<hive>RELOAD",98:"<hive>RELY",99:"<hive>NORELY",100:"<hive>REPAIR",101:"<hive>REPLICATION",102:"<hive>RECOVER",103:"<hive>RENAME",104:"<hive>REPLACE",105:"<hive>RESTRICT",106:"<hive>ROLE",107:"<hive>ROLES",108:"<hive>SCHEMAS",109:"<hive>SEQUENCEFILE",110:"<hive>SERDE",111:"<hive>SERDEPROPERTIES",112:"<hive>SETS",113:"<hive>SHOW",114:"<hive>SKEWED",115:"<hive>SORTED",116:"<hive>STATISTICS",117:"<hive>STORED",118:"<hive>STRING",119:"STRUCT",120:"<hive>TABLES",121:"<hive>TBLPROPERTIES",122:"<hive>TEMPORARY",123:"<hive>TERMINATED",124:"<hive>TEXTFILE",125:"<hive>TIMESTAMP",126:"<hive>TINYINT",127:"<hive>TOUCH",128:"<hive>TRANSACTIONS",129:"<hive>UNARCHIVE",130:"<hive>UNIONTYPE",131:"<hive>USE",132:"<hive>USER",133:"<hive>VIEW",134:"<hive>WAIT",135:"<hive>DAY",136:"<hive>HOUR",137:"<hive>MINUTE",138:"<hive>MONTH",139:"<hive>QUARTER",140:"<hive>SECOND",141:"<hive>WEEK",142:"<hive>YEAR",143:"<impala>ANALYTIC",144:"<impala>CURRENT",145:"<impala>GRANT",146:"<impala>RECOVER",147:"<impala>ROLE",148:"<impala>ROLES",149:"<impala>URI",150:"<impala>SERVER",151:"<impala>UNKNOWN",152:"<impala>BLOCK_SIZE",153:"<impala>COMPRESSION",154:"<impala>DEFAULT",155:"<impala>ENCODING",156:"<impala>KEY",157:"ROLE",158:"OPTION",160:"REGULAR_IDENTIFIER",161:"VARIABLE_REFERENCE",163:"<impala>EXPLAIN",164:"<hive>AUTHORIZATION",165:"<hive>EXTENDED",166:"<hive>ALL",167:"<hive>AS",168:"<hive>BINARY",169:"<hive>CACHE",170:"<hive>CLUSTER",171:"<hive>CONF",172:"<hive>CONSTRAINT",173:"<hive>CUBE",174:"<hive>CURRENT",175:"<hive>DATE",176:"<hive>DISTRIBUTE",177:"<hive>DISTRIBUTED",178:"<hive>EXTERNAL",179:"<hive>FOR",180:"<hive>FOREIGN",181:"<hive>FUNCTION",182:"<hive>GRANT",183:"<hive>GROUPING",184:"<hive>LATERAL",185:"<hive>LOCAL",186:"<hive>LOCK",187:"<hive>MACRO",188:"<hive>PARTITION",189:"<hive>PRIMARY",190:"<hive>REFERENCES",191:"<hive>ROLLUP",192:"<hive>SHOW_DATABASE",193:"<hive>TABLE",194:"<hive>ASC",195:"<hive>FORMATTED",196:"<hive>INDEX",197:"<hive>INDEXES",198:"<hive>NONE",199:"<hive>OF",200:"<hive>OUT",201:"<hive>SCHEMA",202:"<hive>STORED_AS_DIRECTORIES",203:"<hive>TABLESAMPLE",204:"<hive>USING",205:"<hive>VIEWS",206:"<hive>WINDOW",207:"<hive>.",208:"<hive>[",209:"<hive>]",210:"<impala>AGGREGATE",211:"<impala>AVRO",212:"<impala>CACHED",213:"<impala>CASCADE",214:"<impala>CLOSE_FN",215:"<impala>COLUMN",216:"<impala>DATA",217:"<impala>DATABASES",218:"<impala>DELETE",219:"<impala>DELIMITED",220:"<impala>ESCAPED",221:"<impala>EXTENDED",222:"<impala>EXTERNAL",223:"<impala>FIELDS",224:"<impala>FILES",225:"<impala>FINALIZE_FN",226:"<impala>FIRST",227:"<impala>FORMAT",228:"<impala>FORMATTED",229:"<impala>FUNCTION",230:"<impala>FUNCTIONS",231:"<impala>GROUP",232:"<impala>HASH",233:"<impala>ILIKE",234:"<impala>INCREMENTAL",235:"<impala>INTERMEDIATE",236:"<impala>INTERVAL",237:"<impala>INIT_FN",238:"<impala>INPATH",239:"<impala>IREGEXP",240:"<impala>KUDU",241:"<impala>LAST",242:"<impala>LIMIT",243:"<impala>LINES",244:"<impala>LOCATION",245:"<impala>MERGE_FN",246:"<impala>NULLS",247:"<impala>PARTITIONS",248:"<impala>PREPARE_FN",249:"<impala>PRIMARY",250:"<impala>RANGE",251:"<impala>REAL",252:"<impala>REPEATABLE",253:"<impala>REPLICATION",254:"<impala>RESTRICT",255:"<impala>RETURNS",256:"<impala>SCHEMAS",257:"<impala>SERIALIZE_FN",258:"<impala>SORT",259:"<impala>STATS",260:"<impala>STRAIGHT_JOIN",261:"<impala>SYMBOL",262:"<impala>TABLE",263:"<impala>TABLES",264:"<impala>TABLESAMPLE",265:"<impala>USING",266:"<impala>ANTI",267:"<impala>NOSHUFFLE",268:"<impala>PARQUET",269:"<impala>PARTITIONED",270:"<impala>RCFILE",271:"<impala>SEQUENCEFILE",272:"<impala>SERDEPROPERTIES",273:"<impala>SHUFFLE",274:"<impala>STORED",275:"<impala>TBLPROPERTIES",276:"<impala>TERMINATED",277:"<impala>TEXTFILE",278:"<impala>UPDATE_FN",279:"<impala>BROADCAST",280:"<impala>...",281:"<impala>.",282:"<impala>[",283:"<impala>]",284:"ALL",285:"ARRAY",286:"AS",287:"ASC",288:"BETWEEN",289:"BIGINT",290:"BOOLEAN",291:"BY",292:"CASE",293:"CHAR",294:"CROSS",295:"CURRENT",296:"DATABASE",297:"DECIMAL",298:"DISTINCT",299:"DOUBLE",300:"DESC",301:"ELSE",302:"END",303:"EXISTS",304:"FALSE",305:"FLOAT",306:"FOLLOWING",307:"FROM",308:"FULL",309:"GROUP",310:"HAVING",311:"IF",312:"IN",313:"INNER",314:"INT",315:"INTO",316:"IS",317:"JOIN",318:"LEFT",319:"LIKE",320:"LIMIT",321:"MAP",322:"NOT",323:"NULL",324:"ON",325:"ORDER",326:"OUTER",327:"OVER",328:"PARTITION",329:"PRECEDING",330:"PURGE",331:"RANGE",332:"REGEXP",333:"RIGHT",334:"RLIKE",335:"ROW",336:"ROWS",337:"SCHEMA",338:"SEMI",339:"SET",340:"SMALLINT",341:"STRING",342:"TABLE",343:"THEN",344:"TIMESTAMP",345:"TINYINT",346:"TRUE",347:"UNION",348:"VALUES",349:"VARCHAR",350:"WHEN",351:"WHERE",352:"WITH",353:"AVG",354:"CAST",355:"COUNT",356:"MAX",357:"MIN",358:"STDDEV_POP",359:"STDDEV_SAMP",360:"SUM",361:"VARIANCE",362:"VAR_POP",363:"VAR_SAMP",364:"<hive>COLLECT_SET",365:"<hive>COLLECT_LIST",366:"<hive>CORR",367:"<hive>COVAR_POP",368:"<hive>COVAR_SAMP",369:"<hive>DAYOFWEEK",370:"<hive>HISTOGRAM_NUMERIC",371:"<hive>NTILE",372:"<hive>PERCENTILE",373:"<hive>PERCENTILE_APPROX",374:"<impala>APPX_MEDIAN",375:"<impala>EXTRACT",376:"<impala>GROUP_CONCAT",377:"<impala>NDV",378:"<impala>STDDEV",379:"<impala>VARIANCE_POP",380:"<impala>VARIANCE_SAMP",381:"ANALYTIC",382:"UNSIGNED_INTEGER",383:"UNSIGNED_INTEGER_E",384:"HDFS_START_QUOTE",385:"AND",386:"OR",387:"=",388:"<",389:">",390:"COMPARISON_OPERATOR",391:"-",392:"*",393:"ARITHMETIC_OPERATOR",394:",",395:".",396:"~",397:"!",398:"(",399:")",400:"[",401:"]",402:"BACKTICK",403:"SINGLE_QUOTE",404:"DOUBLE_QUOTE",438:"CREATE",439:"<hive>CREATE",440:"<impala>CREATE",441:"PARTIAL_CURSOR",445:"<hive>GROUP",452:"<impala>COMMENT",469:"VALUE",471:"PARTIAL_VALUE",543:"<impala>UNCACHED",569:"<impala>DESCRIBE",570:"<hive>DESCRIBE",571:"<hive>DESC",577:"SELECT",583:"TableExpression_ERROR",656:"<hive>SORT",663:"<impala>OFFSET",668:"BETWEEN_AND",689:"+",727:"<impala>SYSTEM",762:"<impala>REPLACE",763:"TRUNCATE",785:"UNBOUNDED",789:"HDFS_PATH",790:"HDFS_END_QUOTE",794:"<hive>EXTRACT",806:"Errors",826:"ALTER",833:"<impala>PARTITION_VALUE",837:"TO",857:"<hive>SKEWED_LOCATION",860:"<hive>COLUMN",868:"DROP",898:"<impala>COLUMNS",906:"<impala>CHANGE",907:"<impala>FILEFORMAT",908:"<impala>ADD",910:"<impala>RENAME",918:"ColumnReferences",930:"<impala>REFRESH",931:"<impala>INVALIDATE",932:"<impala>METADATA",933:"<impala>COMPUTE",952:"<hive>WITH",957:"<hive>LIFECYCLE",975:"<impala>LIKE_PARQUET",1006:":",1040:"<impala>ORC",1055:"ESCAPED",1101:"VIEW",1166:"<hive>DELETE",1190:"<hive>INSERT",1191:"UPDATE",1192:"<impala>INSERT",1193:"<hive>REVOKE",1195:"<impala>REVOKE",1207:"<hive>OVERWRITE_DIRECTORY",1209:"OptionalStoredAs_EDIT",1213:"INSERT",1227:"<impala>UPSERT",1230:"<impala>OVERWRITE",1252:"<impala>LOAD",1253:"<hive>IMPORT",1278:"SHOW",1314:"USE"},
productions_: [0,[3,3],[7,3],[7,3],[4,0],[5,0],[5,1],[5,4],[5,1],[5,2],[8,1],[8,4],[8,4],[8,7],[9,1],[9,1],[9,1],[9,2],[9,2],[9,2],[12,1],[12,2],[12,1],[12,1],[12,1],[12,1],[12,1],[12,2],[12,2],[12,2],[12,2],[12,2],[12,2],[12,2],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[25,1],[159,1],[159,1],[159,1],[16,2],[16,1],[20,3],[20,2],[162,0],[162,1],[162,1],[162,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[11,1],[13,1],[13,1],[13,1],[13,1],[13,1],[13,1],[13,1],[13,1],[13,1],[13,1],[13,1],[13,1],[13,1],[13,1],[13,1],[21,1],[21,1],[21,1],[21,1],[21,1],[21,1],[21,1],[21,1],[21,1],[21,1],[21,1],[21,1],[21,2],[21,1],[21,1],[434,1],[434,1],[435,1],[435,2],[436,1],[436,1],[437,1],[437,1],[437,1],[17,1],[17,1],[442,1],[442,1],[442,1],[443,1],[443,1],[444,1],[444,1],[444,1],[446,1],[446,1],[447,1],[447,1],[447,1],[448,1],[448,1],[448,1],[449,1],[449,1],[450,1],[450,1],[451,1],[451,1],[453,1],[453,1],[454,1],[454,1],[454,1],[454,1],[455,1],[455,1],[456,1],[456,1],[457,1],[457,1],[458,1],[458,1],[459,1],[459,1],[460,1],[460,1],[461,1],[461,1],[462,1],[462,1],[463,1],[463,1],[464,1],[464,1],[465,1],[465,1],[466,1],[466,1],[467,1],[467,1],[468,3],[468,2],[470,2],[472,3],[472,2],[473,2],[474,1],[474,1],[475,1],[475,1],[476,0],[476,1],[477,0],[477,1],[478,0],[478,1],[478,1],[479,0],[479,1],[479,1],[480,0],[480,1],[480,1],[481,2],[481,1],[482,2],[482,2],[483,0],[483,2],[485,2],[487,0],[487,1],[488,0],[488,1],[488,1],[488,1],[488,1],[489,0],[489,1],[489,1],[490,0],[490,1],[491,0],[491,2],[492,2],[493,0],[493,3],[494,2],[494,3],[495,0],[495,2],[495,2],[496,0],[496,1],[498,1],[497,4],[499,4],[503,5],[506,2],[506,3],[506,4],[506,5],[506,5],[506,5],[505,1],[505,1],[505,1],[505,1],[507,1],[507,1],[507,3],[507,3],[508,1],[508,1],[510,1],[510,1],[511,1],[511,1],[509,2],[502,1],[502,1],[512,0],[512,1],[514,1],[513,3],[515,3],[515,3],[516,1],[516,3],[517,1],[517,3],[517,3],[517,3],[517,5],[517,5],[520,3],[521,1],[521,3],[522,1],[522,3],[522,4],[525,1],[525,3],[525,3],[525,4],[524,1],[524,2],[526,1],[526,2],[526,3],[526,2],[527,2],[528,2],[529,1],[529,3],[530,1],[530,3],[530,3],[484,1],[486,1],[500,1],[500,3],[501,1],[501,3],[501,3],[501,5],[531,3],[531,1],[532,3],[532,3],[532,3],[532,1],[535,0],[535,1],[536,2],[538,2],[540,0],[540,2],[540,1],[544,0],[544,2],[541,3],[545,2],[542,0],[542,1],[546,4],[548,2],[548,3],[523,1],[523,3],[523,2],[549,1],[549,3],[550,1],[550,3],[551,1],[551,2],[552,1],[552,2],[553,1],[553,3],[555,1],[554,1],[554,3],[556,1],[556,3],[556,5],[556,3],[556,3],[556,5],[557,1],[557,3],[558,1],[558,3],[558,5],[558,3],[558,1],[558,3],[558,5],[558,3],[518,1],[518,4],[518,3],[519,4],[519,4],[559,1],[559,1],[560,1],[560,1],[561,1],[561,1],[561,1],[561,1],[561,1],[561,1],[561,1],[561,1],[561,1],[561,1],[561,1],[561,1],[561,2],[561,2],[561,2],[561,1],[561,1],[561,1],[561,1],[563,0],[563,3],[562,0],[562,3],[562,5],[405,1],[405,1],[420,1],[420,1],[564,5],[564,4],[564,4],[564,4],[566,4],[566,5],[566,6],[566,5],[566,5],[566,6],[566,5],[566,4],[566,3],[566,4],[566,5],[566,4],[566,5],[565,3],[565,4],[567,3],[567,3],[567,4],[567,4],[567,5],[568,1],[568,1],[15,2],[15,3],[15,5],[23,2],[23,2],[23,4],[23,3],[23,3],[23,1],[23,4],[23,3],[572,4],[572,5],[572,5],[572,5],[573,0],[573,1],[575,1],[584,1],[584,2],[585,1],[585,2],[585,2],[585,3],[586,4],[587,3],[587,4],[587,4],[574,4],[574,4],[574,5],[574,5],[574,5],[574,6],[574,7],[574,5],[574,5],[574,5],[579,0],[579,1],[18,2],[576,2],[591,1],[591,3],[592,1],[592,3],[592,3],[592,5],[593,5],[594,2],[594,5],[594,5],[578,0],[578,1],[578,1],[578,1],[581,2],[589,2],[589,4],[589,3],[600,0],[600,1],[600,1],[597,3],[599,2],[599,3],[599,3],[598,8],[601,8],[601,8],[601,8],[601,8],[601,8],[601,8],[601,8],[601,8],[601,9],[601,9],[601,9],[601,9],[601,9],[601,9],[601,9],[601,10],[601,10],[601,10],[601,10],[601,10],[601,10],[601,9],[601,9],[601,9],[601,9],[601,9],[601,9],[601,9],[601,9],[601,9],[601,9],[601,9],[601,9],[601,9],[601,9],[601,9],[601,9],[601,9],[601,9],[601,9],[601,9],[601,9],[601,9],[601,9],[601,9],[601,9],[608,0],[608,1],[624,2],[616,2],[616,2],[609,0],[609,1],[625,4],[617,4],[617,4],[617,2],[617,4],[634,0],[634,1],[634,2],[634,2],[636,1],[636,2],[637,5],[638,2],[638,5],[639,0],[639,1],[639,3],[639,3],[640,1],[640,3],[640,3],[640,5],[640,3],[641,1],[641,1],[633,1],[633,3],[635,1],[635,2],[635,3],[635,3],[635,3],[635,4],[635,5],[642,1],[642,2],[642,1],[612,0],[612,1],[628,3],[620,3],[620,2],[643,1],[643,3],[644,1],[644,2],[644,3],[644,4],[644,5],[645,3],[646,3],[646,3],[646,3],[647,0],[647,1],[647,1],[647,1],[647,1],[648,0],[648,2],[648,2],[649,2],[613,0],[613,1],[629,1],[629,1],[629,2],[629,1],[621,1],[621,1],[621,2],[621,2],[621,1],[650,3],[653,2],[653,3],[653,3],[651,3],[654,2],[654,3],[654,3],[652,3],[655,2],[655,3],[657,1],[657,3],[658,1],[658,3],[658,3],[658,5],[659,2],[660,2],[660,2],[614,0],[614,1],[630,2],[630,4],[630,2],[630,4],[630,2],[622,2],[622,2],[622,2],[615,0],[615,1],[662,2],[623,2],[623,2],[631,1],[632,1],[533,1],[533,2],[533,2],[533,2],[533,2],[533,4],[533,4],[533,4],[533,4],[533,6],[533,2],[533,3],[533,3],[533,3],[533,3],[533,3],[533,6],[533,6],[533,5],[533,5],[533,6],[533,5],[533,3],[533,3],[533,3],[533,3],[533,3],[533,2],[533,3],[533,2],[533,3],[534,1],[534,3],[534,2],[534,2],[534,2],[534,2],[534,2],[534,2],[534,2],[534,2],[534,3],[534,4],[534,5],[534,4],[534,4],[534,4],[534,6],[534,6],[534,2],[534,3],[534,3],[534,3],[534,3],[534,3],[534,3],[534,3],[534,3],[534,3],[534,3],[534,3],[534,3],[534,3],[534,3],[534,3],[534,3],[534,3],[534,3],[534,4],[534,3],[534,6],[534,6],[534,5],[534,5],[534,6],[534,6],[534,6],[534,6],[534,5],[534,4],[534,5],[534,5],[534,5],[534,5],[534,4],[534,3],[534,3],[534,3],[534,3],[534,3],[534,3],[534,3],[534,3],[534,3],[534,3],[534,3],[534,3],[534,3],[534,3],[534,3],[534,3],[534,3],[534,3],[534,3],[534,3],[534,2],[534,3],[534,2],[534,3],[534,2],[534,3],[534,2],[534,3],[534,3],[534,4],[534,3],[534,3],[534,3],[667,1],[667,3],[677,1],[677,3],[677,3],[677,5],[677,3],[677,5],[677,4],[677,3],[677,2],[677,2],[677,4],[678,1],[678,3],[664,1],[664,1],[664,2],[664,2],[664,1],[664,1],[664,1],[671,1],[671,1],[671,2],[671,2],[671,1],[671,1],[679,1],[679,3],[685,1],[683,3],[688,3],[547,1],[547,2],[547,2],[504,1],[684,1],[690,1],[690,1],[691,1],[661,1],[661,1],[694,1],[694,2],[694,3],[694,2],[695,2],[695,3],[695,4],[692,1],[692,1],[692,1],[693,1],[693,1],[696,1],[696,1],[665,0],[665,1],[697,2],[697,1],[699,2],[699,3],[699,2],[580,1],[580,3],[588,1],[588,2],[588,3],[588,3],[588,3],[588,4],[588,3],[588,3],[588,4],[588,4],[588,4],[588,5],[588,5],[604,1],[604,3],[606,1],[606,3],[606,3],[606,5],[606,3],[701,1],[702,1],[703,1],[703,1],[704,1],[704,1],[706,2],[708,2],[708,2],[602,4],[602,5],[603,2],[603,3],[711,0],[711,1],[711,1],[713,4],[713,2],[713,4],[713,4],[713,4],[709,1],[709,2],[709,2],[709,3],[710,1],[710,2],[710,2],[710,2],[710,2],[710,2],[710,2],[710,3],[710,2],[710,3],[710,3],[710,3],[710,3],[710,2],[710,3],[710,3],[710,3],[710,3],[714,2],[714,2],[714,2],[714,2],[714,2],[714,3],[714,3],[714,3],[714,3],[714,3],[714,3],[714,3],[714,3],[714,3],[714,3],[714,3],[714,3],[714,3],[714,3],[714,3],[712,0],[712,2],[712,4],[716,1],[716,3],[715,2],[715,2],[705,4],[705,3],[707,4],[707,4],[707,4],[707,3],[707,3],[717,1],[721,1],[720,1],[724,1],[718,0],[718,9],[718,5],[718,5],[718,4],[722,4],[722,6],[722,7],[722,10],[722,9],[722,5],[719,0],[719,5],[719,9],[723,2],[725,0],[725,2],[726,2],[726,2],[728,0],[729,0],[666,3],[666,4],[672,3],[672,3],[595,2],[596,3],[730,1],[731,1],[732,1],[733,1],[734,1],[735,1],[736,1],[737,1],[738,1],[739,1],[740,1],[741,1],[742,1],[743,1],[698,0],[698,1],[698,2],[700,1],[700,2],[700,2],[605,0],[605,2],[607,3],[682,2],[682,2],[682,1],[682,1],[682,1],[687,1],[687,2],[687,1],[687,2],[687,2],[687,2],[687,1],[687,1],[687,1],[760,2],[760,2],[761,2],[761,2],[681,1],[681,1],[681,1],[681,1],[681,1],[681,1],[764,3],[764,2],[764,0],[680,3],[680,4],[686,3],[686,4],[686,3],[746,1],[746,1],[746,1],[753,1],[753,1],[753,1],[748,3],[748,4],[755,4],[755,5],[755,4],[747,0],[747,1],[754,1],[749,2],[749,2],[756,2],[771,4],[772,4],[772,4],[772,5],[772,7],[773,0],[773,1],[777,3],[775,2],[775,3],[775,3],[774,0],[774,2],[776,1],[776,3],[776,2],[778,0],[778,1],[780,5],[780,5],[779,2],[779,6],[779,5],[779,5],[779,5],[779,4],[782,0],[788,0],[537,3],[539,5],[539,4],[539,3],[539,3],[539,2],[781,1],[781,1],[783,0],[783,2],[783,2],[786,2],[786,2],[793,1],[793,1],[793,1],[791,1],[791,1],[784,0],[784,3],[784,3],[787,2],[787,3],[787,3],[792,1],[792,1],[610,0],[610,1],[626,2],[618,2],[618,2],[611,0],[611,1],[627,4],[619,3],[619,4],[750,6],[750,3],[757,6],[757,5],[757,4],[757,6],[757,5],[757,4],[757,6],[757,5],[757,6],[757,5],[765,4],[765,3],[765,5],[768,5],[768,6],[768,5],[751,6],[758,4],[758,5],[758,6],[758,6],[758,6],[758,6],[795,1],[795,1],[795,1],[795,1],[795,1],[795,1],[795,1],[795,1],[795,1],[767,4],[767,5],[770,5],[770,6],[770,5],[796,1],[796,1],[796,1],[796,1],[796,1],[796,1],[796,1],[796,1],[796,1],[796,1],[796,1],[796,1],[796,1],[796,1],[796,1],[796,1],[796,1],[796,1],[796,1],[796,1],[796,1],[796,1],[796,1],[752,6],[752,3],[759,6],[759,5],[759,4],[759,6],[759,5],[759,4],[759,6],[759,5],[759,6],[759,5],[759,6],[759,5],[797,1],[797,1],[766,5],[766,3],[769,5],[769,6],[769,5],[744,6],[744,5],[744,5],[744,7],[744,5],[744,4],[744,2],[745,4],[745,5],[745,6],[745,6],[745,5],[745,6],[745,4],[745,2],[798,0],[798,1],[799,2],[799,4],[800,2],[800,4],[673,3],[673,3],[673,3],[669,2],[669,2],[669,2],[669,2],[669,2],[674,2],[674,2],[674,2],[674,2],[674,2],[674,2],[674,2],[674,2],[674,2],[674,2],[670,2],[670,4],[675,2],[675,4],[675,4],[675,3],[675,4],[675,3],[675,4],[675,4],[675,3],[675,4],[675,3],[676,1],[676,1],[801,1],[801,2],[802,1],[802,2],[802,3],[802,3],[802,2],[803,4],[804,2],[804,3],[804,4],[804,4],[804,3],[804,3],[804,4],[804,2],[804,3],[804,2],[804,3],[804,3],[804,4],[804,3],[804,4],[804,4],[804,5],[804,4],[804,3],[582,1],[582,3],[582,5],[582,3],[582,5],[590,3],[590,5],[590,7],[590,3],[590,5],[590,7],[417,4],[417,4],[417,2],[805,1],[805,3],[809,6],[809,4],[809,3],[809,5],[809,4],[809,6],[406,1],[406,1],[406,1],[406,1],[406,1],[406,1],[406,1],[421,1],[421,1],[421,1],[421,1],[421,1],[421,1],[421,1],[421,2],[812,6],[812,5],[812,6],[819,3],[819,4],[819,5],[819,5],[819,6],[819,6],[813,7],[820,4],[820,5],[820,5],[820,6],[820,7],[814,7],[814,6],[814,7],[814,5],[814,5],[814,4],[814,2],[814,2],[814,2],[814,2],[814,3],[814,3],[821,1],[821,7],[821,4],[821,2],[821,2],[821,2],[821,2],[821,3],[821,4],[821,3],[821,3],[821,7],[821,7],[821,7],[821,8],[821,7],[821,5],[821,6],[821,6],[821,6],[821,4],[821,5],[821,5],[821,5],[821,2],[821,2],[821,2],[821,2],[821,2],[821,3],[821,4],[821,4],[821,3],[821,3],[821,3],[821,4],[821,3],[838,1],[838,6],[838,1],[838,2],[838,2],[838,2],[838,2],[838,2],[838,3],[838,3],[838,4],[838,5],[847,2],[847,2],[847,1],[847,1],[847,2],[847,3],[847,4],[847,3],[847,4],[847,2],[847,3],[847,3],[847,2],[847,3],[847,3],[847,3],[847,6],[847,4],[847,7],[847,6],[847,2],[847,2],[839,6],[839,5],[839,5],[848,3],[848,4],[848,5],[848,5],[848,6],[848,3],[848,4],[848,5],[848,5],[867,1],[867,1],[867,1],[867,1],[867,1],[866,0],[866,1],[869,3],[870,3],[871,1],[871,3],[872,1],[872,3],[872,5],[872,3],[873,3],[874,1],[841,3],[841,2],[841,3],[841,4],[841,3],[841,3],[841,4],[841,2],[841,1],[841,1],[841,4],[841,2],[841,6],[849,1],[849,3],[849,6],[849,7],[849,6],[849,5],[849,4],[849,4],[849,2],[849,2],[849,3],[849,2],[849,2],[849,4],[849,3],[849,3],[849,4],[849,5],[849,4],[849,5],[849,4],[881,0],[881,2],[891,2],[882,0],[882,4],[892,2],[892,3],[880,4],[888,4],[888,5],[896,1],[896,1],[855,5],[863,2],[863,3],[863,4],[863,5],[863,5],[863,2],[863,5],[899,4],[899,4],[900,4],[900,4],[901,3],[901,5],[902,3],[902,5],[840,4],[840,3],[840,3],[840,5],[840,6],[840,3],[850,3],[850,4],[850,5],[850,3],[850,2],[850,4],[850,5],[850,5],[850,5],[850,2],[850,3],[850,3],[830,3],[842,3],[842,3],[859,1],[859,1],[875,1],[875,1],[831,1],[831,1],[843,1],[843,1],[851,1],[851,1],[887,0],[887,2],[909,1],[909,1],[890,2],[890,2],[885,0],[885,1],[836,1],[836,1],[883,1],[883,1],[884,2],[884,1],[893,3],[878,1],[878,1],[856,1],[856,1],[903,1],[903,3],[905,1],[905,3],[905,5],[905,3],[905,3],[905,3],[905,5],[904,0],[904,1],[832,0],[832,1],[911,1],[911,2],[844,1],[844,2],[844,2],[844,3],[913,2],[913,2],[912,2],[858,3],[864,3],[914,1],[914,3],[915,1],[915,3],[915,5],[915,3],[916,3],[917,1],[917,1],[917,3],[917,3],[917,3],[854,0],[854,1],[865,2],[865,3],[815,4],[815,3],[815,4],[815,6],[822,1],[822,2],[822,3],[822,3],[822,3],[822,3],[822,4],[919,3],[920,3],[920,3],[816,4],[823,2],[823,3],[823,4],[823,4],[817,2],[824,2],[818,6],[825,2],[825,3],[825,4],[825,5],[825,6],[922,1],[922,1],[407,9],[422,2],[422,3],[422,4],[422,4],[422,5],[422,6],[422,10],[422,10],[422,10],[422,4],[422,9],[422,9],[422,9],[422,9],[422,9],[923,0],[923,1],[926,2],[928,2],[924,0],[924,1],[927,2],[929,2],[925,0],[925,1],[408,3],[408,3],[423,2],[423,3],[423,4],[423,3],[423,3],[409,2],[409,3],[424,2],[424,3],[424,3],[424,3],[410,5],[410,5],[425,2],[425,3],[425,3],[425,4],[425,6],[425,5],[425,5],[425,5],[425,3],[425,5],[425,4],[425,5],[425,6],[425,5],[411,1],[411,1],[411,1],[411,1],[411,1],[411,1],[411,1],[426,1],[426,1],[426,1],[426,1],[426,1],[426,1],[426,4],[934,3],[934,5],[811,3],[810,3],[810,3],[946,0],[946,1],[949,2],[950,2],[950,2],[950,3],[950,3],[948,1],[947,0],[947,1],[951,3],[951,2],[951,2],[827,3],[953,1],[953,3],[954,3],[935,7],[956,0],[956,2],[941,6],[941,6],[941,5],[955,11],[958,11],[958,11],[958,11],[958,11],[958,11],[958,11],[958,11],[958,11],[958,12],[958,11],[958,11],[959,2],[967,2],[967,2],[973,0],[973,1],[973,2],[973,2],[974,1],[974,2],[974,2],[974,2],[861,3],[861,5],[897,3],[897,5],[897,5],[976,1],[976,3],[978,1],[978,3],[978,3],[978,5],[978,2],[978,4],[978,4],[978,6],[886,3],[889,3],[889,3],[889,3],[981,0],[981,1],[984,1],[984,2],[983,1],[983,2],[983,2],[983,3],[985,1],[985,2],[985,2],[985,2],[985,2],[985,2],[985,1],[985,1],[986,1],[986,2],[980,1],[980,1],[980,1],[980,1],[980,1],[980,1],[980,1],[980,1],[980,1],[982,1],[982,1],[982,1],[982,1],[989,4],[993,3],[997,4],[997,4],[990,6],[994,3],[998,6],[998,4],[998,6],[998,5],[991,4],[995,3],[999,4],[1002,1],[1002,3],[1003,1],[1003,2],[1003,3],[1003,3],[1003,5],[1004,4],[1005,5],[1005,4],[1005,4],[1005,4],[1005,3],[1005,3],[992,4],[996,3],[1000,4],[1007,1],[1007,3],[1008,1],[1008,2],[1008,3],[1008,3],[1008,5],[1009,2],[1009,2],[1009,1],[1009,1],[1001,1],[1001,1],[977,1],[977,1],[977,3],[977,5],[979,1],[979,1],[979,3],[979,5],[979,5],[979,5],[979,3],[979,3],[979,4],[834,4],[845,1],[845,2],[845,3],[845,4],[845,4],[835,9],[846,2],[846,3],[846,4],[846,5],[846,5],[846,6],[846,7],[846,8],[846,10],[1014,0],[1014,1],[1014,1],[1010,2],[1011,1],[1011,2],[1011,2],[987,2],[988,2],[1012,2],[1013,2],[960,0],[960,1],[1015,3],[1015,5],[1015,6],[968,2],[968,3],[968,3],[968,2],[968,2],[968,3],[968,4],[968,5],[968,4],[968,5],[968,6],[961,0],[961,1],[1018,3],[969,2],[969,3],[1016,3],[1017,3],[1017,3],[1019,1],[1019,3],[1020,1],[1020,3],[1020,5],[1020,3],[1020,5],[1021,6],[1021,4],[1021,4],[1021,3],[1022,2],[1022,2],[1022,3],[1022,2],[1022,3],[1022,4],[1022,4],[1022,5],[1022,6],[1022,6],[1022,3],[1022,4],[1022,4],[1023,1],[1023,1],[962,0],[962,1],[852,7],[862,2],[862,4],[862,7],[862,5],[862,7],[862,7],[862,4],[1024,0],[1024,3],[1025,2],[1025,3],[1026,3],[1027,3],[1028,1],[1028,3],[1029,1],[1029,3],[1029,3],[1029,5],[1030,2],[1031,3],[1031,2],[1031,2],[963,0],[963,1],[1032,5],[1032,6],[970,2],[970,4],[853,3],[1033,1],[1033,3],[964,0],[964,1],[1034,1],[1034,4],[1034,4],[1034,4],[971,2],[971,1],[971,2],[971,3],[971,3],[971,5],[971,4],[1037,0],[1037,1],[1035,3],[1038,3],[876,1],[876,4],[876,1],[876,1],[876,1],[876,1],[876,1],[876,1],[876,1],[876,1],[876,1],[876,1],[876,1],[876,1],[1036,1],[1036,1],[1039,1],[1039,1],[1041,1],[1041,3],[1041,3],[1042,1],[1043,6],[1044,6],[1044,6],[1044,6],[1044,6],[1044,6],[879,3],[894,3],[894,3],[1045,0],[1045,4],[1045,7],[1050,2],[1050,3],[1050,6],[1046,0],[1046,5],[1051,2],[1051,3],[1051,4],[1047,0],[1047,5],[1052,2],[1052,3],[1052,4],[1048,0],[1048,4],[1053,2],[1053,3],[1049,0],[1049,4],[1054,2],[1054,3],[877,0],[877,1],[1056,3],[1056,3],[895,2],[895,3],[965,0],[965,1],[1057,2],[1058,0],[1058,2],[966,0],[966,3],[972,3],[972,3],[1059,0],[936,9],[942,4],[942,10],[942,3],[942,7],[942,8],[942,9],[942,9],[942,9],[938,1],[938,1],[938,1],[938,1],[943,1],[943,1],[943,1],[943,1],[1062,8],[1066,4],[1066,9],[1066,6],[1066,7],[1066,8],[1066,3],[1066,5],[1066,6],[1066,7],[1066,8],[1066,8],[1066,8],[1066,8],[1063,16],[1067,3],[1067,17],[1067,5],[1067,4],[1067,16],[1067,6],[1067,16],[1067,7],[1067,8],[1067,10],[1067,11],[1067,17],[1067,7],[1067,9],[1067,9],[1067,10],[1067,10],[1067,16],[1067,16],[1067,16],[1067,16],[1067,16],[1067,16],[1067,16],[1067,16],[1067,16],[1067,16],[1064,6],[1068,4],[1068,6],[1068,7],[1065,6],[1069,5],[1070,2],[1070,4],[1073,3],[1073,4],[1093,1],[1093,3],[1095,1],[1095,3],[1095,3],[1095,5],[1094,0],[1094,1],[1071,2],[1074,2],[1072,3],[1075,0],[1075,3],[1083,3],[1076,3],[1084,3],[1077,3],[1085,3],[1078,0],[1078,3],[1086,3],[1079,0],[1079,3],[1087,3],[1080,0],[1080,3],[1088,3],[1081,0],[1081,3],[1089,3],[1082,0],[1082,2],[1090,2],[1096,1],[1097,1],[1091,0],[1091,2],[1092,2],[1098,1],[1098,3],[1099,2],[1100,1],[1100,1],[1100,1],[921,1],[921,1],[1060,0],[1060,1],[1102,3],[1061,3],[1103,2],[1103,4],[1104,3],[1104,5],[1104,5],[1104,7],[937,3],[1105,1],[1105,1],[1105,1],[939,16],[1106,1],[1112,1],[944,4],[944,5],[944,6],[944,6],[944,7],[944,8],[944,9],[944,16],[944,16],[944,16],[944,16],[944,16],[944,16],[944,16],[944,17],[1108,1],[1114,1],[1109,0],[1109,3],[1115,2],[1115,3],[1110,0],[1110,2],[1111,0],[1111,3],[1116,2],[1116,3],[1116,3],[1107,3],[1113,3],[1117,1],[1117,3],[1118,1],[1118,3],[1118,3],[1118,5],[940,6],[945,5],[945,6],[945,6],[945,6],[1119,2],[1119,3],[1120,3],[1121,1],[1121,3],[1122,1],[1122,3],[1122,3],[1122,5],[1123,2],[1124,2],[1124,2],[14,1],[14,1],[14,1],[14,1],[14,1],[14,1],[14,1],[22,1],[22,1],[22,1],[22,1],[22,1],[22,2],[22,2],[22,2],[22,2],[22,1],[22,1],[22,1],[22,1],[22,1],[412,1],[412,1],[412,1],[412,1],[412,1],[412,1],[412,1],[412,1],[412,1],[427,1],[427,1],[427,1],[427,1],[427,1],[427,1],[427,1],[427,1],[427,2],[1144,5],[1153,3],[1153,3],[1153,4],[1153,5],[1153,5],[1153,6],[1145,1],[1145,1],[1154,1],[1154,1],[1161,5],[1161,6],[1163,4],[1163,5],[1163,6],[1163,3],[1163,6],[1163,5],[1163,3],[1163,7],[1163,4],[1163,6],[1163,5],[1163,6],[1162,4],[1162,5],[1164,4],[1164,5],[1164,3],[1164,4],[1164,4],[1164,5],[1164,4],[1146,3],[1147,3],[1147,5],[1155,3],[1155,3],[1155,4],[1155,5],[1155,3],[1155,4],[1155,4],[1155,5],[1155,5],[1155,5],[1148,5],[1156,3],[1156,4],[1156,5],[1156,5],[1156,6],[1165,0],[1165,1],[1165,1],[1149,6],[1157,4],[1157,3],[1157,5],[1157,6],[1157,6],[1150,5],[1158,3],[1158,5],[1158,4],[1151,4],[1159,4],[1159,5],[1159,3],[1159,4],[1159,4],[1152,5],[1160,2],[1160,5],[1160,4],[1160,5],[1160,6],[1160,5],[1160,6],[1160,5],[1125,4],[1132,2],[1132,3],[1132,5],[1132,4],[1132,4],[1126,5],[1133,3],[1133,2],[1133,4],[1133,6],[1133,3],[1133,5],[1133,5],[1133,5],[1167,0],[1167,1],[1168,1],[413,3],[428,2],[1169,1],[1169,3],[414,6],[414,5],[414,6],[414,6],[414,7],[414,8],[429,2],[429,3],[429,3],[429,4],[429,5],[429,5],[429,7],[429,6],[429,3],[429,4],[429,4],[429,6],[429,5],[429,5],[429,5],[429,7],[429,6],[429,2],[429,4],[429,5],[429,2],[429,3],[429,4],[429,4],[429,5],[429,6],[429,8],[429,7],[429,9],[429,8],[1171,0],[1171,2],[1179,2],[1179,2],[1185,2],[1185,2],[1185,1],[1186,2],[1186,2],[1186,2],[1186,1],[1177,2],[1177,2],[1177,2],[1177,2],[1184,2],[1184,2],[1184,2],[1170,1],[1170,3],[1178,1],[1178,3],[1178,3],[1178,5],[1178,3],[1178,3],[1178,5],[1187,2],[1188,2],[1189,1],[1189,1],[1189,1],[1189,1],[1189,1],[1189,1],[1189,1],[1189,1],[1189,1],[1189,1],[1189,1],[1176,1],[1176,1],[1176,1],[1176,1],[1176,1],[1176,1],[1176,2],[1183,2],[1172,1],[1172,3],[1180,3],[1180,3],[1180,5],[828,2],[828,2],[828,2],[829,2],[829,2],[829,2],[1174,1],[1174,3],[1173,0],[1173,3],[1173,3],[1181,2],[1181,3],[1181,3],[1175,0],[1175,3],[1182,2],[1182,3],[415,5],[415,8],[415,4],[415,5],[415,7],[415,8],[415,5],[415,6],[415,6],[415,7],[430,2],[430,2],[430,3],[430,4],[430,5],[430,5],[430,3],[430,4],[430,5],[430,5],[430,6],[430,7],[430,8],[430,8],[430,3],[430,4],[430,4],[430,4],[430,5],[430,5],[430,4],[430,5],[430,6],[430,7],[430,7],[430,7],[430,8],[430,8],[430,3],[430,4],[430,2],[430,4],[430,5],[430,2],[430,3],[430,4],[430,4],[430,5],[430,6],[1194,1],[1194,2],[1196,2],[1127,1],[1127,1],[1127,1],[1127,2],[1127,2],[1127,1],[1137,2],[1137,2],[1137,3],[1134,1],[1134,2],[1134,2],[1134,2],[1134,2],[1134,1],[1134,2],[1134,3],[1134,2],[1134,3],[1134,3],[1199,6],[1199,7],[1199,5],[1199,6],[1202,2],[1202,4],[1202,6],[1202,6],[1202,6],[1202,4],[1202,7],[1202,7],[1202,7],[1202,5],[1202,5],[1202,5],[1202,4],[1202,6],[1202,6],[1202,6],[1200,1],[1200,2],[1203,1],[1203,2],[1203,2],[1203,3],[1210,3],[1211,1],[1211,3],[1211,2],[1211,3],[1211,3],[1197,7],[1197,7],[1197,6],[1135,2],[1135,4],[1135,4],[1135,5],[1135,6],[1212,1],[1212,3],[1215,3],[1214,0],[1214,1],[1206,0],[1206,3],[1208,2],[1208,3],[1208,3],[1201,4],[1204,5],[1204,4],[1204,4],[1205,0],[1205,1],[1138,1],[1136,1],[1216,4],[1216,3],[1217,1],[1217,3],[1217,4],[1217,4],[1217,4],[1217,3],[1217,3],[1218,1],[1218,1],[1221,1],[1221,1],[1223,5],[1225,2],[1225,4],[1225,6],[1225,5],[1225,5],[1224,6],[1226,2],[1226,4],[1226,7],[1226,6],[1226,6],[1226,6],[1229,1],[1229,1],[1228,0],[1228,1],[1219,0],[1219,1],[1219,1],[1220,1],[1220,3],[1222,1],[1222,3],[1222,5],[1222,3],[1231,3],[1232,3],[1232,3],[1198,4],[1139,1],[1139,2],[1139,3],[1139,3],[1139,4],[1139,4],[1233,9],[1235,2],[1235,3],[1235,3],[1235,4],[1235,5],[1235,6],[1235,7],[1235,7],[1235,8],[1235,9],[1237,3],[1237,1],[1238,3],[1238,3],[1238,1],[1234,1],[1234,2],[1234,3],[1236,1],[1236,2],[1236,2],[1236,3],[1236,3],[1239,6],[1240,3],[1240,5],[1240,4],[1240,6],[1240,6],[1241,0],[1241,2],[1243,2],[1242,3],[1242,1],[1242,3],[1244,2],[1244,3],[1244,2],[1128,10],[1140,2],[1140,4],[1140,6],[1140,7],[1140,8],[1140,9],[1140,10],[1140,11],[1140,10],[1140,10],[1251,0],[1251,1],[1251,1],[1249,0],[1249,1],[1247,1],[1247,1],[1248,1],[1248,1],[1250,1],[1250,1],[1129,6],[1141,3],[1141,3],[1141,2],[1141,6],[1141,6],[1141,7],[1141,7],[1141,6],[1141,7],[1254,0],[1254,1],[1255,4],[1255,3],[1256,2],[1256,3],[1256,4],[1256,4],[1256,2],[1256,3],[1256,3],[1130,7],[1130,12],[1142,2],[1142,3],[1142,3],[1142,5],[1142,4],[1142,7],[1142,8],[1142,9],[1142,7],[1142,12],[1142,8],[1142,13],[1142,7],[1142,12],[1142,12],[807,1],[807,3],[808,1],[808,1],[808,2],[808,1],[808,1],[808,1],[808,1],[416,3],[416,3],[416,3],[431,3],[418,1],[418,1],[418,1],[418,1],[418,1],[418,1],[418,1],[418,1],[418,1],[418,1],[418,1],[418,1],[418,1],[418,1],[418,1],[418,1],[418,1],[418,1],[418,1],[418,1],[1277,1],[1277,1],[432,2],[432,3],[432,4],[432,1],[432,1],[432,1],[432,1],[432,1],[432,1],[432,1],[432,1],[432,1],[432,1],[432,1],[432,1],[432,1],[432,1],[432,1],[432,1],[1257,4],[1279,3],[1279,4],[1279,4],[1258,4],[1258,6],[1280,3],[1280,4],[1280,4],[1280,5],[1280,6],[1280,5],[1280,6],[1280,6],[1259,2],[1260,3],[1261,4],[1281,3],[1281,4],[1281,4],[1281,4],[1295,1],[1295,1],[1262,3],[1262,3],[1282,3],[1282,3],[1263,4],[1263,3],[1283,3],[1264,5],[1284,3],[1284,4],[1284,5],[1284,6],[1284,5],[1284,5],[1265,2],[1265,3],[1265,4],[1265,6],[1285,3],[1285,4],[1285,5],[1285,6],[1285,6],[1285,6],[1266,3],[1266,5],[1266,5],[1266,6],[1266,4],[1286,3],[1286,5],[1286,5],[1286,6],[1286,6],[1286,3],[1296,0],[1296,1],[1297,1],[1297,2],[1267,4],[1267,6],[1287,2],[1287,2],[1287,4],[1287,6],[1287,3],[1287,4],[1287,4],[1287,5],[1287,6],[1287,6],[1287,6],[1268,3],[1268,4],[1268,4],[1268,5],[1268,4],[1288,3],[1288,3],[1288,4],[1288,4],[1288,4],[1288,5],[1288,5],[1288,4],[1269,3],[1269,4],[1269,3],[1269,4],[1289,3],[1289,3],[1289,4],[1289,4],[1289,3],[1289,3],[1289,4],[1289,4],[1270,5],[1270,5],[1290,3],[1290,3],[1290,5],[1290,4],[1290,5],[1290,4],[1290,5],[1271,2],[1271,2],[1272,6],[1272,7],[1291,3],[1291,4],[1291,4],[1291,5],[1291,6],[1291,6],[1291,6],[1291,7],[1291,7],[1291,7],[1291,7],[1291,8],[1291,3],[1291,4],[1291,4],[1291,4],[1273,3],[1273,4],[1273,5],[1292,4],[1274,3],[1274,6],[1293,3],[1293,3],[1275,2],[1276,4],[1294,5],[1294,4],[1294,4],[1298,0],[1298,2],[1298,2],[1300,2],[1300,2],[1299,0],[1299,2],[1301,2],[1131,6],[1143,6],[1143,6],[1143,6],[1143,6],[1143,7],[1143,3],[1143,2],[1143,2],[1143,2],[1302,1],[1304,1],[1306,1],[1307,1],[1245,1],[1245,3],[1246,1],[1246,3],[1246,3],[1246,5],[1308,3],[1309,3],[1309,2],[1309,1],[1310,1],[1311,1],[1312,1],[1303,0],[1303,2],[1305,2],[1305,2],[1313,1],[1313,1],[419,2],[433,2]],
performAction: function anonymous(yytext, yyleng, yylineno, yy, yystate /* action[1] */, $$ /* vstack */, _$ /* lstack */) {
/* this == yyval */

var $0 = $$.length - 1;
switch (yystate) {
case 2: case 3:

     return parser.yy.result;
   
break;
case 4:

     parser.prepareNewStatement();
   
break;
case 6: case 10: case 12:

     parser.addStatementLocation(_$[$0]);
   
break;
case 11: case 13:

     parser.addStatementLocation(_$[$0-3]);
   
break;
case 20: case 33:

     if (parser.isHive()) {
       parser.suggestDdlAndDmlKeywords(['EXPLAIN', 'FROM']);
     } else if (parser.isImpala()) {
       parser.suggestDdlAndDmlKeywords(['EXPLAIN']);
     } else {
       parser.suggestDdlAndDmlKeywords();
     }
   
break;
case 21:

     if (parser.isHive() || parser.isImpala()) {
       parser.suggestKeywords(['INSERT', 'SELECT']);
     } else {
       parser.suggestKeywords(['SELECT']);
     }
   
break;
case 172:

     if (!$$[$0-1]) {
       parser.suggestDdlAndDmlKeywords([{ value: 'AUTHORIZATION', weight: 2 }, { value: 'DEPENDENCY', weight: 2 }, { value: 'EXTENDED', weight: 2 }]);
     } else {
       parser.suggestDdlAndDmlKeywords();
     }
   
break;
case 173:

     parser.suggestDdlAndDmlKeywords();
   
break;
case 545:

     parser.suggestSetOptions();
     if (parser.isHive()) {
       parser.suggestKeywords(['ROLE']);
     }
     if (parser.isImpala()) {
       parser.suggestKeywords(['ALL']);
     }
   
break;
case 613: case 616: case 721: case 762: case 856: case 1098: case 1281: case 1393: case 1453: case 2591: case 2593: case 3094:
this.$ = $$[$0-1];
break;
case 614: case 617: case 763:
this.$ = '';
break;
case 638:

     parser.suggestKeywords(['INDEX', 'INDEXES']);
   
break;
case 639:

     parser.suggestKeywords(['FORMATTED']);
   
break;
case 656: case 659:

     parser.yy.correlatedSubQuery = false;
   
break;
case 657: case 661:

     parser.suggestKeywords(['EXISTS']);
   
break;
case 660:

     parser.suggestKeywords(['NOT EXISTS']);
   
break;
case 671: case 673: case 674: case 676:

     parser.suggestKeywords(['<', '<=', '<>', '=', '>', '>=']);
   
break;
case 672: case 675: case 3121:

     parser.suggestKeywords(['VALUES']);
   
break;
case 699: case 703: case 707: case 743: case 744: case 789: case 792: case 1000: case 1069: case 1843: case 1941: case 1960: case 2006: case 2008: case 2372: case 2631: case 3409:

     parser.suggestColumns();
   
break;
case 711: case 764:

     parser.addTableLocation(_$[$0], [ { name: $$[$0] } ]);
     this.$ = { identifierChain: [ { name: $$[$0] } ] };
   
break;
case 712: case 765:

     parser.addDatabaseLocation(_$[$0-2], [ { name: $$[$0-2] } ]);
     parser.addTableLocation(_$[$0], [ { name: $$[$0-2] }, { name: $$[$0] } ]);
     this.$ = { identifierChain: [ { name: $$[$0-2] }, { name: $$[$0] } ] };
   
break;
case 713:

     // This is a special case for Impala expression like "SELECT | FROM db.table.col"
     this.$ = { identifierChain: [ { name: $$[$0-3] }, { name: $$[$0-1] } ].concat($$[$0]) };
   
break;
case 714: case 1747: case 1913: case 2080: case 2086: case 2095: case 2280: case 2604: case 2628: case 2731: case 2736: case 2754: case 2777: case 2784: case 2841: case 2849: case 3128: case 3159: case 3162: case 3168: case 3395: case 3415:

     parser.suggestTables();
     parser.suggestDatabases({ appendDot: true });
   
break;
case 715: case 729:

     parser.suggestDatabases();
     this.$ = { identifierChain: [{ name: $$[$0-2] }] };
   
break;
case 716:

     // In Impala you can have statements like 'SELECT ... FROM testTable t, t.|'
     parser.suggestTablesOrColumns($$[$0-2]);
   
break;
case 717:

     // TODO: switch to suggestColumns, it's currently handled in sqlAutocompleter2.js
     // Issue is that suggestColumns is deleted if no tables are defined and this is
     // Impala only cases like "SELECT | FROM db.table.col"
     parser.suggestTables({ identifierChain: [{ name: $$[$0-3] }, { name: $$[$0-1] }].concat($$[$0]) });
   
break;
case 718: case 898:
this.$ = [$$[$0]];
break;
case 719:

     $$[$0-1].push($$[$0]);
   
break;
case 720: case 723:
this.$ = [];
break;
case 722: case 858: case 1283:
this.$ = $$[$0-2];
break;
case 724:
this.$ = { name: $$[$0] };
break;
case 728: case 1798: case 2025:

     parser.suggestDatabases({ appendDot: true });
   
break;
case 732: case 2039: case 2076: case 2840: case 2848: case 3249: case 3309: case 3323: case 3381: case 3382: case 3420:

     parser.suggestDatabases();
   
break;
case 742: case 1005: case 1006: case 1012: case 1013: case 1389: case 1480: case 3079: case 3115:

     parser.valueExpressionSuggest();
   
break;
case 750: case 753:

     if (!$$[$0]) {
       this.$ = { suggestKeywords: ['WITH REPLICATION ='] };
     }
   
break;
case 755: case 3267:

     parser.suggestKeywords(['IN']);
   
break;
case 759:

     parser.suggestKeywords(['REPLICATION =']);
   
break;
case 760: case 1781: case 1938: case 2333:

     parser.suggestKeywords(['=']);
   
break;
case 766: case 3372:

     parser.suggestTables();
     parser.suggestDatabases({ prependDot: true });
   
break;
case 767:

     parser.suggestTablesOrColumns($$[$0-2]);
   
break;
case 769:
this.$ = { identifierChain: $$[$0-1].identifierChain, alias: $$[$0] };
break;
case 772:

     parser.yy.locations[parser.yy.locations.length - 1].type = 'column';
   
break;
case 773: case 1234:

     parser.addAsteriskLocation(_$[$0], $$[$0-2].concat({ asterisk: true }));
   
break;
case 775:

     this.$ = [ $$[$0].identifier ];
     parser.yy.firstChainLocation = parser.addUnknownLocation($$[$0].location, [ $$[$0].identifier ]);
   
break;
case 776:

     if (parser.yy.firstChainLocation) {
       parser.yy.firstChainLocation.firstInChain = true;
       delete parser.yy.firstChainLocation;
     }
     $$[$0-2].push($$[$0].identifier);
     parser.addUnknownLocation($$[$0].location, $$[$0-2].concat());
   
break;
case 777: case 785:

     if ($$[$0].insideKey) {
       parser.suggestKeyValues({ identifierChain: [ $$[$0].identifier ] });
       parser.suggestColumns();
       parser.suggestFunctions();
     }
   
break;
case 778: case 786:

     if ($$[$0].insideKey) {
       parser.suggestKeyValues({ identifierChain: $$[$0-2].concat([ $$[$0].identifier ]) });
       parser.suggestColumns();
       parser.suggestFunctions();
     }
   
break;
case 781:

     parser.suggestColumns({
       identifierChain: $$[$0-2]
     });
     this.$ = { suggestKeywords: [{ value: '*', weight: 10000 }] };
   
break;
case 782:

     parser.suggestColumns({
       identifierChain: $$[$0-4]
     });
     this.$ = { suggestKeywords: [{ value: '*', weight: 10000 }] };
   
break;
case 783:
this.$ = [ $$[$0].identifier ];
break;
case 784:

     $$[$0-2].push($$[$0].identifier);
   
break;
case 787:

     if ($$[$0-2].insideKey) {
       parser.suggestKeyValues({ identifierChain: $$[$0-4].concat([ $$[$0-2].identifier ]) });
       parser.suggestColumns();
       parser.suggestFunctions();
     }
   
break;
case 788:

     if ($$[$0-2].insideKey) {
       parser.suggestKeyValues({ identifierChain: [ $$[$0-2].identifier ] });
       parser.suggestColumns();
       parser.suggestFunctions();
     }
   
break;
case 790:

     parser.suggestColumns({ identifierChain: $$[$0-2] });
   
break;
case 791:

     parser.suggestColumns({ identifierChain: $$[$0-4] });
   
break;
case 793:
this.$ = { identifier: { name: $$[$0] }, location: _$[$0] };;
break;
case 794:
this.$ = { identifier: { name: $$[$0-3], keySet: true }, location: _$[$0-3] };
break;
case 795:
this.$ = { identifier: { name: $$[$0-2], keySet: true }, location: _$[$0-2] };
break;
case 796:
this.$ = { identifier: { name: $$[$0-3] }, insideKey: true };
break;
case 797:
this.$ = { identifier: { name: $$[$0-3] }};;
break;
case 830:

     parser.addTablePrimary($$[$0-2]);
     parser.addColumnLocation(_$[$0-1], $$[$0-1]);
   
break;
case 831: case 1749: case 2048: case 2070: case 2084: case 2098: case 2282: case 2730: case 2740: case 2741: case 2766: case 2772: case 2775: case 2780: case 3122: case 3131: case 3132: case 3161: case 3171: case 3266: case 3312: case 3313: case 3325: case 3327:

     parser.addTablePrimary($$[$0-1]);
   
break;
case 832: case 848: case 2071:

     parser.addDatabaseLocation(_$[$0], [{ name: $$[$0] }]);
   
break;
case 835: case 1745: case 2083: case 2090: case 2091: case 3314:

     parser.addTablePrimary($$[$0-2]);
   
break;
case 836:

     if (!$$[$0-4]) {
       parser.suggestKeywords(['EXTENDED', 'FORMATTED']);
     }
   
break;
case 837:

     if (!$$[$0-3]) {
       parser.suggestKeywords(['EXTENDED', 'FORMATTED']);
     }
   
break;
case 838:

     parser.addTablePrimary($$[$0-2]);
     parser.suggestColumns();
     if (!$$[$0]) {
       parser.suggestKeywords(['PARTITION']);
     }
   
break;
case 839:

     if (!$$[$0]) {
       parser.suggestKeywords(['PARTITION']);
     }
   
break;
case 842:

     if (!$$[$0-1]) {
       parser.suggestKeywords(['DATABASE', 'EXTENDED', 'FORMATTED', 'FUNCTION', 'SCHEMA']);
     }
     parser.suggestTables();
     parser.suggestDatabases({ appendDot: true });
    
break;
case 843: case 845:

     if (!$$[$0-1]) {
       parser.suggestKeywords(['EXTENDED']);
     }
   
break;
case 844: case 846:

      if (!$$[$0-2]) {
        parser.suggestKeywords(['EXTENDED']);
      }
    
break;
case 847: case 1943: case 2026: case 2029: case 2078: case 2600: case 2729: case 2750: case 2760: case 2764: case 2838: case 2839: case 2845: case 3095: case 3164: case 3236: case 3252: case 3311: case 3324: case 3326: case 3369: case 3398:

     parser.addTablePrimary($$[$0]);
   
break;
case 849:

     if (!$$[$0-1]) {
       parser.suggestKeywords([{ value: 'DATABASE', weight: 2 }, { value: 'EXTENDED', weight: 1 }, { value: 'FORMATTED', weight: 1 }]);
     }
     parser.suggestTables();
     parser.suggestDatabases({ appendDot: true });
   
break;
case 851:

     parser.addTablePrimary($$[$0]);
     if (!$$[$0-2]) {
       parser.suggestKeywords([{ value: 'DATABASE', weight: 2 }, { value: 'EXTENDED', weight: 1 }, { value: 'FORMATTED', weight: 1 }]);
     }
   
break;
case 852:

     if (!$$[$0-1]) {
       parser.suggestKeywords(['EXTENDED', 'FORMATTED']);
     }
     parser.suggestDatabases();
   
break;
case 853:

      if (!$$[$0-2]) {
        parser.suggestKeywords(['EXTENDED', 'FORMATTED']);
      }
      parser.addDatabaseLocation(_$[$0], [{ name: $$[$0] }]);
    
break;
case 861:

     parser.addCommonTableExpressions($$[$0-3]);
   
break;
case 862: case 863: case 901:

     parser.addCommonTableExpressions($$[$0-2]);
   
break;
case 867:

     parser.addClauseLocation('selectList', parser.firstDefined($$[$0-1], _$[$0-1], $$[$0-2], _$[$0-2], $$[$0-3], _$[$0-3]), _$[$0]);
     this.$ = { selectList: $$[$0] };
   
break;
case 868:

     parser.addClauseLocation('selectList', parser.firstDefined($$[$0-2], _$[$0-2], $$[$0-3], _$[$0-3], $$[$0-4], _$[$0-4]), _$[$0-1]);
     this.$ = { selectList: $$[$0-1], tableExpression: $$[$0] }
   
break;
case 881:

     parser.suggestKeywords(['ALL', 'DISTINCT', 'SELECT']);
   
break;
case 882:

     parser.suggestKeywords(['ALL', 'DISTINCT']);
   
break;
case 884:

     parser.addClauseLocation('selectList', parser.firstDefined($$[$0-1], _$[$0-1], $$[$0-2], _$[$0-2], $$[$0-3], _$[$0-3]), _$[$0]);
     if ($$[$0].cursorAtStart) {
       var keywords = parser.getSelectListKeywords();
       if (!$$[$0-1] && !$$[$0-2]) {
         keywords.push({ value: 'ALL', weight: 2 });
         keywords.push({ value: 'DISTINCT', weight: 2 });
       }
       if (parser.isImpala() && !$$[$0-1]) {
         keywords.push({ value: 'STRAIGHT_JOIN', weight: 1 });
       }
       parser.suggestKeywords(keywords);
     } else {
       parser.checkForSelectListKeywords($$[$0]);
     }
     if ($$[$0].suggestFunctions) {
       parser.suggestFunctions();
     }
     if ($$[$0].suggestColumns) {
       parser.suggestColumns({ identifierChain: [], source: 'select' });
     }
     if ($$[$0].suggestTables) {
       parser.suggestTables({ prependQuestionMark: true, prependFrom: true });
     }
     if ($$[$0].suggestDatabases) {
       parser.suggestDatabases({ prependQuestionMark: true, prependFrom: true, appendDot: true });
     }
     if ($$[$0].suggestAggregateFunctions && (!$$[$0-2] || $$[$0-2] === 'ALL')) {
       parser.suggestAggregateFunctions();
       parser.suggestAnalyticFunctions();
     }
   
break;
case 885:

     parser.addClauseLocation('selectList', parser.firstDefined($$[$0-1], _$[$0-1], $$[$0-2], _$[$0-2], $$[$0-3], _$[$0-3]), _$[$0], true);
     var keywords = parser.getSelectListKeywords();
     if (!$$[$0-2] || $$[$0-2] === 'ALL') {
       parser.suggestAggregateFunctions();
       parser.suggestAnalyticFunctions();
     }
     if (!$$[$0-1] && !$$[$0-2]) {
       keywords.push({ value: 'ALL', weight: 2 });
       keywords.push({ value: 'DISTINCT', weight: 2 });
     }
     if (parser.isImpala() && !$$[$0-1]) {
       keywords.push({ value: 'STRAIGHT_JOIN', weight: 1 });
     }
     parser.suggestKeywords(keywords);
     parser.suggestFunctions();
     parser.suggestColumns({ identifierChain: [], source: 'select' });
     parser.suggestTables({ prependQuestionMark: true, prependFrom: true });
     parser.suggestDatabases({ prependQuestionMark: true, prependFrom: true, appendDot: true });
   
break;
case 886:

     parser.addClauseLocation('selectList', parser.firstDefined($$[$0-2], _$[$0-2], $$[$0-3], _$[$0-3], $$[$0-4], _$[$0-4]), _$[$0-1]);
   
break;
case 887:

     parser.addClauseLocation('selectList', parser.firstDefined($$[$0-2], _$[$0-2], $$[$0-3], _$[$0-3], $$[$0-4], _$[$0-4]), _$[$0-1]);
     parser.selectListNoTableSuggest($$[$0-1], $$[$0-3]);
     if (parser.yy.result.suggestColumns) {
       parser.yy.result.suggestColumns.source = 'select';
     }
   
break;
case 888:

     parser.addClauseLocation('selectList', parser.firstDefined($$[$0-2], _$[$0-2], $$[$0-3], _$[$0-3], $$[$0-4], _$[$0-4]), _$[$0-1], true);
     var keywords = parser.getSelectListKeywords();
     if (!$$[$0-3] || $$[$0-3] === 'ALL') {
       parser.suggestAggregateFunctions();
       parser.suggestAnalyticFunctions();
     }
     if (!$$[$0-2] && !$$[$0-3]) {
       keywords.push({ value: 'ALL', weight: 2 });
       keywords.push({ value: 'DISTINCT', weight: 2 });
     }
     if (parser.isImpala() && !$$[$0-2]) {
       keywords.push({ value: 'STRAIGHT_JOIN', weight: 1 });
     }
     parser.suggestKeywords(keywords);
     parser.suggestFunctions();
     parser.suggestColumns({ identifierChain: [], source: 'select' });
     parser.suggestTables({ prependQuestionMark: true, prependFrom: true });
     parser.suggestDatabases({ prependQuestionMark: true, prependFrom: true, appendDot: true });
   
break;
case 889:

     parser.addClauseLocation('selectList', parser.firstDefined($$[$0-3], _$[$0-3], $$[$0-4], _$[$0-4], $$[$0-5], _$[$0-5]), _$[$0-2]);
     parser.checkForSelectListKeywords($$[$0-2]);
   
break;
case 890:

     parser.addClauseLocation('selectList', parser.firstDefined($$[$0-4], _$[$0-4], $$[$0-5], _$[$0-5], $$[$0-6], _$[$0-6]), _$[$0-3]);
     parser.checkForSelectListKeywords($$[$0-3]);
   
break;
case 891:

     parser.addClauseLocation('selectList', parser.firstDefined($$[$0-2], _$[$0-2], $$[$0-3], _$[$0-3], $$[$0-4], _$[$0-4]), _$[$0-1]);
     parser.checkForSelectListKeywords($$[$0-1]);
     var keywords = ['FROM'];
     if (parser.yy.result.suggestKeywords) {
       keywords = parser.yy.result.suggestKeywords.concat(keywords);
     }
     parser.suggestKeywords(keywords);
     parser.suggestTables({ prependFrom: true });
     parser.suggestDatabases({ prependFrom: true, appendDot: true });
   
break;
case 892:

     parser.selectListNoTableSuggest($$[$0-1], $$[$0-3]);
   
break;
case 896: case 972: case 1003: case 1016: case 1020: case 1058: case 1062: case 1090: case 1116: case 1117: case 1198: case 1200: case 1268: case 1278: case 1285: case 1297: case 1478: case 1678: case 1679: case 1704: case 1705: case 1706: case 1989: case 2153: case 2170: case 3114: case 3414:
this.$ = $$[$0];
break;
case 899:
this.$ = $$[$0-2].concat([$$[$0]]);;
break;
case 903:

     parser.addCommonTableExpressions($$[$0-4]);
   
break;
case 904:

     parser.addCteAliasLocation(_$[$0-4], $$[$0-4]);
     $$[$0-1].alias = $$[$0-4];
     this.$ = $$[$0-1];
   
break;
case 905: case 1533: case 2393: case 2453: case 2530: case 2534: case 2607:

     parser.suggestKeywords(['AS']);
   
break;
case 906: case 1396: case 2022: case 2467: case 2476: case 3096:

     parser.suggestKeywords(['SELECT']);
   
break;
case 912: case 913:

     parser.addClauseLocation('whereClause', _$[$0-1], $$[$0].whereClauseLocation);
     parser.addClauseLocation('limitClause', $$[$0].limitClausePreceding || _$[$0-1], $$[$0].limitClauseLocation);
   
break;
case 914:

     var keywords = [];

     parser.addClauseLocation('whereClause', _$[$0-3], $$[$0-1].whereClauseLocation);
     parser.addClauseLocation('limitClause', $$[$0-2].limitClausePreceding || _$[$0-3], $$[$0-2].limitClauseLocation);

     if ($$[$0-3]) {
       if (!$$[$0-3].hasLateralViews && typeof $$[$0-3].tableReferenceList.hasJoinCondition !== 'undefined' && !$$[$0-3].tableReferenceList.hasJoinCondition) {
         keywords.push({ value: 'ON', weight: 3 });
         if (parser.isImpala()) {
           keywords.push({ value: 'USING', weight: 3 });
         }
       }
       if ($$[$0-3].suggestKeywords) {
         keywords = parser.createWeightedKeywords($$[$0-3].suggestKeywords, 3);
       }
       if ($$[$0-3].tableReferenceList.suggestJoinConditions) {
         parser.suggestJoinConditions($$[$0-3].tableReferenceList.suggestJoinConditions);
       }
       if ($$[$0-3].tableReferenceList.suggestJoins) {
         parser.suggestJoins($$[$0-3].tableReferenceList.suggestJoins);
       }
       if (!$$[$0-3].hasLateralViews && $$[$0-3].tableReferenceList.suggestKeywords) {
         keywords = keywords.concat(parser.createWeightedKeywords($$[$0-3].tableReferenceList.suggestKeywords, 3));
       }

       // Lower the weights for 'TABLESAMPLE' and 'LATERAL VIEW'
       keywords.forEach(function (keyword) {
         if (keyword.value === 'TABLESAMPLE' || keyword.value === 'LATERAL VIEW') {
           keyword.weight = 1.1;
         }
       });

       if (!$$[$0-3].hasLateralViews && $$[$0-3].tableReferenceList.types) {
         var veKeywords = parser.getValueExpressionKeywords($$[$0-3].tableReferenceList);
         keywords = keywords.concat(veKeywords.suggestKeywords);
         if (veKeywords.suggestColRefKeywords) {
           parser.suggestColRefKeywords(veKeywords.suggestColRefKeywords);
           parser.addColRefIfExists($$[$0-3].tableReferenceList);
         }
       }
     }

     if ($$[$0-1].empty && $$[$0] && $$[$0].joinType.toUpperCase() === 'JOIN') {
       keywords = keywords.concat(['FULL', 'FULL OUTER', 'LEFT', 'LEFT OUTER', 'RIGHT', 'RIGHT OUTER']);
       if (parser.isHive()) {
         keywords = keywords.concat(['CROSS', 'INNER', 'LEFT SEMI']);
       } else if (parser.isImpala()) {
         keywords = keywords.concat(['ANTI', 'CROSS', 'INNER', 'LEFT ANTI', 'LEFT INNER', 'LEFT SEMI', 'OUTER', 'RIGHT ANTI', 'RIGHT INNER', 'RIGHT SEMI', 'SEMI']);
       } else {
         keywords.push('INNER');
       }
       parser.suggestKeywords(keywords);
       return;
     }

     if ($$[$0-1].suggestKeywords) {
       keywords = keywords.concat(parser.createWeightedKeywords($$[$0-1].suggestKeywords, 2));
     }

     if ($$[$0-1].suggestFilters) {
       parser.suggestFilters($$[$0-1].suggestFilters);
     }
     if ($$[$0-1].suggestGroupBys) {
       parser.suggestGroupBys($$[$0-1].suggestGroupBys);
     }
     if ($$[$0-1].suggestOrderBys) {
       parser.suggestOrderBys($$[$0-1].suggestOrderBys);
     }

     if ($$[$0-1].empty) {
       keywords.push({ value: 'UNION', weight: 2.11 });
     }

     keywords = keywords.concat([
       { value: 'FULL JOIN', weight: 1 },
       { value: 'FULL OUTER JOIN', weight: 1 },
       { value: 'JOIN', weight: 1 },
       { value: 'LEFT JOIN', weight: 1 },
       { value: 'LEFT OUTER JOIN', weight: 1 },
       { value: 'RIGHT JOIN', weight: 1 },
       { value: 'RIGHT OUTER JOIN', weight: 1 }
     ]);
     if (parser.isHive()) {
       keywords = keywords.concat([
         { value: 'CROSS JOIN', weight: 1 },
         { value: 'INNER JOIN', weight: 1 },
         { value: 'LEFT SEMI JOIN', weight: 1 }
       ]);
     } else if (parser.isImpala()) {
       keywords = keywords.concat([
         { value: 'ANTI JOIN', weight: 1 },
         { value: 'INNER JOIN', weight: 1 },
         { value: 'LEFT ANTI JOIN', weight: 1 },
         { value: 'LEFT INNER JOIN', weight: 1 },
         { value: 'LEFT SEMI JOIN', weight: 1 },
         { value: 'OUTER JOIN', weight: 1 },
         { value: 'RIGHT ANTI JOIN', weight: 1 },
         { value: 'RIGHT INNER JOIN', weight: 1 },
         { value: 'RIGHT SEMI JOIN', weight: 1 },
         { value: 'SEMI JOIN', weight: 1 }
       ]);
     } else {
       keywords.push({ value: 'INNER JOIN', weight: 1 });
     }
     parser.suggestKeywords(keywords);
  
break;
case 915:

     // A couple of things are going on here:
     // - If there are no SelectConditions (WHERE, GROUP BY, etc.) we should suggest complete join options
     // - If there's an OptionalJoin at the end, i.e. 'SELECT * FROM foo | JOIN ...' we should suggest
     //   different join types
     // - The FromClause could end with a valueExpression, in which case we should suggest keywords like '='
     //   or 'AND' based on type

     if (!$$[$0-1]) {
       parser.addClauseLocation('whereClause', _$[$0-2]);
       parser.addClauseLocation('limitClause', _$[$0-2]);
       return;
     }
     parser.addClauseLocation('whereClause', _$[$0-2], $$[$0-1].whereClauseLocation);
     parser.addClauseLocation('limitClause', $$[$0-1].limitClausePreceding || _$[$0-2], $$[$0-1].limitClauseLocation);
     var keywords = [];

     if ($$[$0-1].suggestColRefKeywords) {
       parser.suggestColRefKeywords($$[$0-1].suggestColRefKeywords);
       parser.addColRefIfExists($$[$0-1]);
     }

     if ($$[$0-1].suggestKeywords && $$[$0-1].suggestKeywords.length) {
       keywords = keywords.concat(parser.createWeightedKeywords($$[$0-1].suggestKeywords, 2));
     }

     if ($$[$0-1].cursorAtEnd) {
       keywords.push({ value: 'UNION', weight: 2.11 });
     }
     parser.suggestKeywords(keywords);
   
break;
case 919:

     if (parser.isHive()) {
       this.$ = { tableReferenceList : $$[$0-1], suggestKeywords: ['LATERAL VIEW'] }
     } else {
       this.$ = { tableReferenceList : $$[$0-1] }
     }
     if (parser.isHive() && $$[$0]) {
       parser.yy.lateralViews = $$[$0].lateralViews;
       this.$.hasLateralViews = true;
       if ($$[$0].suggestKeywords) {
         this.$.suggestKeywords = this.$.suggestKeywords.concat($$[$0].suggestKeywords);
       }
     }
   
break;
case 920: case 1290:

       parser.suggestTables();
       parser.suggestDatabases({ appendDot: true });
   
break;
case 921:

     if ($$[$0]) {
       parser.yy.lateralViews = $$[$0].lateralViews;
     }
   
break;
case 923:

     var keywords = parser.getKeywordsForOptionalsLR(
       [$$[$0-7], $$[$0-6], $$[$0-5], $$[$0-4], $$[$0-3], $$[$0-2], $$[$0-2], $$[$0-1], $$[$0]],
       [{ value: 'WHERE', weight: 9 }, { value: 'GROUP BY', weight: 8 }, { value: 'HAVING', weight: 7 }, { value: 'WINDOW', weight: 6 }, { value: 'ORDER BY', weight: 5 }, [{ value: 'CLUSTER BY', weight: 4 }, { value: 'DISTRIBUTE BY', weight: 4 }], { value: 'SORT BY', weight: 4 }, { value: 'LIMIT', weight: 3 }, { value: 'OFFSET', weight: 2 }],
       [true, true, true, parser.isHive(), true, parser.isHive(), parser.isHive() && !$$[$0-3], true, parser.isImpala()]);

     if (keywords.length > 0) {
       this.$ = { suggestKeywords: keywords, empty: !$$[$0-7] && !$$[$0-6] && !$$[$0-5] && !$$[$0-4] && !$$[$0-3] && !$$[$0-2] && !$$[$0-1] && !$$[$0] };
     } else {
       this.$ = {};
     }

     this.$.whereClauseLocation = $$[$0-7] ? _$[$0-7] : undefined;
     this.$.limitClausePreceding = parser.firstDefined($$[$0-2], _$[$0-2], $$[$0-3], _$[$0-3], $$[$0-4], _$[$0-4], $$[$0-5], _$[$0-5], $$[$0-6], _$[$0-6], $$[$0-7], _$[$0-7]);
     this.$.limitClauseLocation = $$[$0-1] ? _$[$0-1] : undefined;

     if (!$$[$0-7] && !$$[$0-6] && !$$[$0-5] && !$$[$0-4] && !$$[$0-3] && !$$[$0-2] && !$$[$0-1] && !$$[$0]) {
       this.$.suggestFilters = { prefix: 'WHERE', tablePrimaries: parser.yy.latestTablePrimaries.concat() };
     }
     if (!$$[$0-6] && !$$[$0-5] && !$$[$0-4] && !$$[$0-3] && !$$[$0-2] && !$$[$0-1] && !$$[$0]) {
       this.$.suggestGroupBys = { prefix: 'GROUP BY', tablePrimaries: parser.yy.latestTablePrimaries.concat() };
     }
     if (!$$[$0-3] && !$$[$0-2] && !$$[$0-1] && !$$[$0]) {
       this.$.suggestOrderBys = { prefix: 'ORDER BY', tablePrimaries: parser.yy.latestTablePrimaries.concat() };
     }
   
break;
case 924:

     if (parser.yy.result.suggestColumns) {
       parser.yy.result.suggestColumns.source = 'where';
     }
   
break;
case 925:

     if (parser.yy.result.suggestColumns) {
       parser.yy.result.suggestColumns.source = 'group by';
     }
   
break;
case 928:

     if (parser.yy.result.suggestColumns) {
       parser.yy.result.suggestColumns.source = 'order by';
     }
   
break;
case 932:

     var keywords = parser.getKeywordsForOptionalsLR(
       [$$[$0-6], $$[$0-5], $$[$0-4], $$[$0-3], $$[$0-2], $$[$0-2], $$[$0-1], $$[$0]],
       [{ value: 'GROUP BY', weight: 8 }, { value: 'HAVING', weight: 7 }, { value: 'WINDOW', weight: 6 }, { value: 'ORDER BY', weight: 5 }, [{ value: 'CLUSTER BY', weight: 4 }, { value: 'DISTRIBUTE BY', weight: 4 }], { value: 'SORT BY', weight: 4 }, { value: 'LIMIT', weight: 3 }, { value: 'OFFSET', weight: 2 }],
       [true, true, parser.isHive(), true, parser.isHive(), parser.isHive() && !$$[$0-3], true, parser.isImpala()]);
     if ($$[$0-8].suggestKeywords) {
       keywords = keywords.concat(parser.createWeightedKeywords($$[$0-8].suggestKeywords, 1));
     }
     this.$ = parser.getValueExpressionKeywords($$[$0-8], keywords);
     this.$.cursorAtEnd = !$$[$0-6] && !$$[$0-5] && !$$[$0-4] && !$$[$0-3] && !$$[$0-2] && !$$[$0-1] && !$$[$0];
     if ($$[$0-8].columnReference) {
       this.$.columnReference = $$[$0-8].columnReference;
     }
     if (!$$[$0-6]) {
       parser.suggestGroupBys({ prefix: 'GROUP BY', tablePrimaries: parser.yy.latestTablePrimaries.concat() });
     }
     if (!$$[$0-6] && !$$[$0-5] && !$$[$0-4] && !$$[$0-3]) {
       parser.suggestOrderBys({ prefix: 'ORDER BY', tablePrimaries: parser.yy.latestTablePrimaries.concat() });
     }
     this.$.whereClauseLocation = $$[$0-8] ? _$[$0-8] : undefined;
     this.$.limitClausePreceding = parser.firstDefined($$[$0-2], _$[$0-2], $$[$0-3], _$[$0-3], $$[$0-4], _$[$0-4], $$[$0-5], _$[$0-5], $$[$0-6], _$[$0-6], $$[$0-8], _$[$0-8]);
     this.$.limitClauseLocation = $$[$0-1] ? _$[$0-1] : undefined;
   
break;
case 933:

     var keywords = parser.getKeywordsForOptionalsLR(
       [$$[$0-5], $$[$0-4], $$[$0-3], $$[$0-2], $$[$0-2], $$[$0-1], $$[$0]],
       [{ value: 'HAVING', weight: 7 }, { value: 'WINDOW', weight: 6 }, { value: 'ORDER BY', weight: 5 }, [{ value: 'CLUSTER BY', weight: 4 }, { value: 'DISTRIBUTE BY', weight: 4 }], { value: 'SORT BY', weight: 4 }, { value: 'LIMIT', weight: 3 }, { value: 'OFFSET', weight: 2 }],
       [true, parser.isHive(), true, parser.isHive(), parser.isHive() && !$$[$0-3], true, parser.isImpala()]);
     if ($$[$0-7].suggestKeywords) {
       keywords = keywords.concat(parser.createWeightedKeywords($$[$0-7].suggestKeywords, 8));
     }
     if ($$[$0-7].valueExpression) {
       this.$ = parser.getValueExpressionKeywords($$[$0-7].valueExpression, keywords);
       if ($$[$0-7].valueExpression.columnReference) {
         this.$.columnReference = $$[$0-7].valueExpression.columnReference;
       }
     } else {
       this.$ = { suggestKeywords: keywords };
     }
     this.$.cursorAtEnd = !$$[$0-5] && !$$[$0-4] && !$$[$0-3] && !$$[$0-2] && !$$[$0-1] && !$$[$0];
     if (!$$[$0-5] && !$$[$0-4] && !$$[$0-3]) {
       parser.suggestOrderBys({ prefix: 'ORDER BY', tablePrimaries: parser.yy.latestTablePrimaries.concat() });
     }
     this.$.whereClauseLocation = $$[$0-8] ? _$[$0-8] : undefined;
     this.$.limitClausePreceding = parser.firstDefined($$[$0-2], _$[$0-2], $$[$0-3], _$[$0-3], $$[$0-4], _$[$0-4], $$[$0-5], _$[$0-5], $$[$0-7], _$[$0-7]);
     this.$.limitClauseLocation = $$[$0-1] ? _$[$0-1] : undefined;
   
break;
case 934:

     var keywords = parser.getKeywordsForOptionalsLR(
       [$$[$0-4], $$[$0-3], $$[$0-2], $$[$0-2], $$[$0-1], $$[$0]],
       [{ value: 'WINDOW', weight: 6 }, { value: 'ORDER BY', weight: 5 }, [{ value: 'CLUSTER BY', weight: 4 }, { value: 'DISTRIBUTE BY', weight: 4 }], { value: 'SORT BY', weight: 4 }, { value: 'LIMIT', weight: 3 }, { value: 'OFFSET', weight: 2 }],
       [parser.isHive(), true, parser.isHive(), parser.isHive() && !$$[$0-3], true, parser.isImpala()]);
     this.$ = { suggestKeywords: keywords, cursorAtEnd: !$$[$0-4] && !$$[$0-3] && !$$[$0-2] && !$$[$0-1] && !$$[$0] };
     if (!$$[$0-4] && !$$[$0-3]) {
       parser.suggestOrderBys({ prefix: 'ORDER BY', tablePrimaries: parser.yy.latestTablePrimaries.concat() });
     }
     this.$.whereClauseLocation = $$[$0-8] ? _$[$0-8] : undefined;
     this.$.limitClausePreceding = parser.firstDefined($$[$0-2], _$[$0-2], $$[$0-3], _$[$0-3], $$[$0-4], _$[$0-4], $$[$0-6], _$[$0-6]);
     this.$.limitClauseLocation = $$[$0-1] ? _$[$0-1] : undefined;
   
break;
case 935:

     var keywords = parser.getKeywordsForOptionalsLR([$$[$0-3], $$[$0-2], $$[$0-1], $$[$0]], [{ value: 'ORDER BY', weight: 5 }, [{ value: 'CLUSTER BY', weight: 4 }, { value: 'DISTRIBUTE BY', weight: 4 }, { value: 'SORT BY', weight: 4 }], { value: 'LIMIT', weight: 3 }, { value: 'OFFSET', weight: 2 }], [true, parser.isHive(), true, parser.isImpala()]);
     this.$ = { suggestKeywords: keywords, cursorAtEnd: !$$[$0-3] && !$$[$0-2] && !$$[$0-1] && !$$[$0] };
     if (!$$[$0-3]) {
       parser.suggestOrderBys({ prefix: 'ORDER BY', tablePrimaries: parser.yy.latestTablePrimaries.concat() });
     }
     this.$.whereClauseLocation = $$[$0-8] ? _$[$0-8] : undefined;
     this.$.limitClausePreceding = parser.firstDefined($$[$0-2], _$[$0-2], $$[$0-3], _$[$0-3], $$[$0-5], _$[$0-5]);
     this.$.limitClauseLocation = $$[$0-1] ? _$[$0-1] : undefined;
   
break;
case 936:

     var keywords = parser.getKeywordsForOptionalsLR([$$[$0-2], $$[$0-1], $$[$0]], [[{ value: 'CLUSTER BY', weight: 4 }, { value: 'DISTRIBUTE BY', weight: 4 }], { value: 'LIMIT', weight: 3 }, { value: 'OFFSET', weight: 2 }], [parser.isHive(), true, parser.isImpala()]);
     if ($$[$0-4].suggestKeywords) {
       keywords = keywords.concat(parser.createWeightedKeywords($$[$0-4].suggestKeywords, 5));
     }
     this.$ = { suggestKeywords: keywords, cursorAtEnd: !$$[$0-2] && !$$[$0-1] && !$$[$0] };
     this.$.whereClauseLocation = $$[$0-8] ? _$[$0-8] : undefined;
     this.$.limitClausePreceding = parser.firstDefined($$[$0-2], _$[$0-2], $$[$0-4], _$[$0-4]);
     this.$.limitClauseLocation = $$[$0-1] ? _$[$0-1] : undefined;
   
break;
case 937:

     var keywords = parser.getKeywordsForOptionalsLR([$$[$0-1], $$[$0]], [{ value: 'LIMIT', weight: 3 }, { value: 'OFFSET', weight: 2 }], [true, parser.isImpala()]);
     if ($$[$0-3].suggestKeywords) {
       keywords = keywords.concat(parser.createWeightedKeywords($$[$0-3].suggestKeywords, 4));
     }
     this.$ = { suggestKeywords: keywords, cursorAtEnd: !$$[$0-1] && !$$[$0] };
     this.$.whereClauseLocation = $$[$0-8] ? _$[$0-8] : undefined;
     this.$.limitClausePreceding = _$[$0-3];
     this.$.limitClauseLocation = $$[$0-1] ? _$[$0-1] : undefined;
   
break;
case 938:

     var keywords = parser.getKeywordsForOptionalsLR([$$[$0]], [{ value: 'OFFSET', weight: 2 }], [parser.isImpala()]);
     this.$ = { suggestKeywords: keywords, cursorAtEnd: !$$[$0] };
     this.$.whereClauseLocation = $$[$0-8] ? _$[$0-8] : undefined;
     this.$.limitClausePreceding = parser.firstDefined($$[$0-3], _$[$0-3], $$[$0-4], _$[$0-4], $$[$0-5], _$[$0-5], $$[$0-6], _$[$0-6], $$[$0-7], _$[$0-7], $$[$0-8], _$[$0-8]);
     this.$.limitClauseLocation = $$[$0-2] ? _$[$0-2] : undefined;
   
break;
case 939:

     this.$ = {
       suggestKeywords: parser.getKeywordsForOptionalsLR([$$[$0-6], $$[$0-5], $$[$0-4], $$[$0-3], $$[$0-2], $$[$0-1], $$[$0]], [{ value: 'GROUP BY', weight: 8 }, { value: 'HAVING', weight: 7 }, { value: 'WINDOW', weight: 6 }, { value: 'ORDER BY', weight: 5 }, [{ value: 'CLUSTER BY', weight: 4 }, { value: 'DISTRIBUTE BY', weight: 4 }, { value: 'SORT BY', weight: 4 }], { value: 'LIMIT', weight: 3 }, { value: 'OFFSET', weight: 2 }], [true, true, parser.isHive(), true, parser.isHive(), true, parser.isImpala()]),
       cursorAtEnd: !$$[$0-6] && !$$[$0-5] && !$$[$0-4] && !$$[$0-3] && !$$[$0-2] && !$$[$0-1] && !$$[$0]
     };
   
break;
case 940:

     this.$ = {
       suggestKeywords: parser.getKeywordsForOptionalsLR([$$[$0-4], $$[$0-3], $$[$0-2], $$[$0-1], $$[$0]], [{ value: 'WINDOW', weight: 6 }, { value: 'ORDER BY', weight: 5 }, [{ value: 'CLUSTER BY', weight: 4 }, { value: 'DISTRIBUTE BY', weight: 4 }, { value: 'SORT BY', weight: 4 }], { value: 'LIMIT', weight: 3 }, { value: 'OFFSET', weight: 2 }], [parser.isHive(), true, parser.isHive(), true, parser.isImpala()]),
       cursorAtEnd: !$$[$0-4] && !$$[$0-3] && !$$[$0-2] && !$$[$0-1] && !$$[$0]
     }
   
break;
case 941:

     this.$ = {
       suggestKeywords: parser.getKeywordsForOptionalsLR([$$[$0-3], $$[$0-2], $$[$0-1], $$[$0]], [{ value: 'ORDER BY', weight: 5 }, [{ value: 'CLUSTER BY', weight: 4 }, { value: 'DISTRIBUTE BY', weight: 4 }, { value: 'SORT BY', weight: 4 }], { value: 'LIMIT', weight: 3 }, { value: 'OFFSET', weight: 2 }], [true, parser.isHive(), true, parser.isImpala()]),
       cursorAtEnd: !$$[$0-3] && !$$[$0-2] && !$$[$0-1] && !$$[$0]
     }
   
break;
case 942:

     this.$ = {
       suggestKeywords: parser.getKeywordsForOptionalsLR([$$[$0-2], $$[$0-1], $$[$0]], [[{ value: 'CLUSTER BY', weight: 4 }, { value: 'DISTRIBUTE BY', weight: 4 }, { value: 'SORT BY', weight: 4 }], { value: 'LIMIT', weight: 3 }, { value: 'OFFSET', weight: 2 }], [parser.isHive(), true, parser.isImpala()]),
       cursorAtEnd: !$$[$0-2] && !$$[$0-1] && !$$[$0]
     }
   
break;
case 943:

     this.$ = {
       suggestKeywords: parser.getKeywordsForOptionalsLR([$$[$0-1], $$[$0]], [{ value: 'LIMIT', weight: 3 }, { value: 'OFFSET', weight: 2 }], [true, parser.isImpala()]),
       cursorAtEnd: !$$[$0-1] && !$$[$0]
     }
   
break;
case 944:

     this.$ = {
       suggestKeywords: parser.getKeywordsForOptionalsLR([$$[$0]], [{ value: 'OFFSET', weight: 2 }], [parser.isImpala()]),
       cursorAtEnd: !$$[$0]
     }
   
break;
case 973:

     if ($$[$0].suggestFilters) {
       parser.suggestFilters({ tablePrimaries: parser.yy.latestTablePrimaries.concat() });
     }
   
break;
case 974:

     parser.suggestFunctions();
     parser.suggestColumns();
     parser.suggestKeywords(['EXISTS', 'NOT EXISTS']);
     parser.suggestFilters({ tablePrimaries: parser.yy.latestTablePrimaries.concat() });
   
break;
case 977:

     this.$ = { valueExpression: $$[$0] ? false : $$[$0-1] };
     if (!$$[$0] && parser.isHive()) {
       this.$.suggestKeywords = ['GROUPING SETS', 'WITH CUBE', 'WITH ROLLUP'];
     }
   
break;
case 978: case 1027: case 1053: case 1057: case 1060:

     parser.suggestSelectListAliases();
   
break;
case 979:

     parser.valueExpressionSuggest();
     parser.suggestSelectListAliases();
     parser.suggestGroupBys({ tablePrimaries: parser.yy.latestTablePrimaries.concat() });
   
break;
case 980:

     parser.suggestKeywords(['BY']);
     parser.suggestGroupBys({ prefix: 'BY', tablePrimaries: parser.yy.latestTablePrimaries.concat() });
   
break;
case 987:

     if (parser.isHive()) {
       parser.suggestKeywords(['CUBE', 'ROLLUP']);
     }
   
break;
case 989:

     parser.suggestKeywords(['SETS']);
   
break;
case 1017:

     if ($$[$0].emptyOrderBy) {
       parser.suggestOrderBys({ tablePrimaries: parser.yy.latestTablePrimaries.concat() });
     }
   
break;
case 1018:

     parser.suggestKeywords(['BY']);
     parser.suggestOrderBys({ prefix: 'BY', tablePrimaries: parser.yy.latestTablePrimaries.concat() });
   
break;
case 1022:

     this.$ = { emptyOrderBy: false }
     parser.valueExpressionSuggest();
     parser.suggestAnalyticFunctions();
     parser.suggestSelectListAliases();
   
break;
case 1023: case 1024: case 1025:
this.$ = { emptyOrderBy: false };
break;
case 1026:
this.$ = parser.mergeSuggestKeywords($$[$0-1], $$[$0]);
break;
case 1029:

     this.$ = { emptyOrderBy: true }
     parser.valueExpressionSuggest();
     parser.suggestAnalyticFunctions();
     parser.suggestSelectListAliases();
   
break;
case 1030:

    this.$ = { suggestKeywords: ['ASC', 'DESC'] };
  
break;
case 1035:

    if (parser.isImpala()) {
      this.$ = { suggestKeywords: ['NULLS FIRST', 'NULLS LAST'] };
    } else {
      this.$ = {};
    }
  
break;
case 1038:

     parser.suggestKeywords(['FIRST', 'LAST']);
   
break;
case 1042:
this.$ = { suggestKeywords: ['SORT BY'] };
break;
case 1051: case 1055: case 1059:

     suggestKeywords: ['BY'];
   
break;
case 1052: case 1056:

     parser.suggestColumns();
     parser.suggestSelectListAliases();
   
break;
case 1067:

     parser.addColumnLocation($$[$0-1].location, [ $$[$0-1].identifier ]);
     this.$ = $$[$0];
   
break;
case 1078: case 1083:

     parser.suggestFunctions({ types: ['BIGINT'] });
   
break;
case 1079: case 1084:

     delete parser.yy.result.suggestColumns;
   
break;
case 1088: case 1089:

     // verifyType($$[$0], 'BOOLEAN');
     this.$ = { types: [ 'BOOLEAN' ] };
   
break;
case 1091:

     // verifyType($$[$0], 'NUMBER');
     this.$ = $$[$0];
     $$[$0].types = ['NUMBER'];
   
break;
case 1092: case 1093: case 1094: case 1095: case 1096: case 1103: case 1104: case 1105: case 1106: case 1107: case 1108: case 1114: case 1115: case 1136: case 1194: case 1195: case 1257:
this.$ = { types: [ 'BOOLEAN' ] };
break;
case 1097:

     this.$ = { types: [ 'BOOLEAN' ] };
     // clear correlated flag after completed sub-query (set by lexer)
     parser.yy.correlatedSubQuery = false;
   
break;
case 1099: case 1100: case 1101: case 1102:

     parser.addColRefToVariableIfExists($$[$0-2], $$[$0]);
     this.$ = { types: [ 'BOOLEAN' ] };
   
break;
case 1109: case 1110:

     // verifyType($$[$0-2], 'BOOLEAN');
     // verifyType($$[$0], 'BOOLEAN');
     this.$ = { types: [ 'BOOLEAN' ] };
   
break;
case 1111: case 1112: case 1113:

     // verifyType($$[$0-2], 'NUMBER');
     // verifyType($$[$0], 'NUMBER');
     this.$ = { types: [ 'NUMBER' ] };
   
break;
case 1119:

     if (parser.isImpala()) {
       parser.suggestKeywords(['BETWEEN', 'EXISTS', 'IN', 'ILIKE', 'IREGEXP', 'LIKE', 'REGEXP', 'RLIKE']);
     } else {
       parser.suggestKeywords(['BETWEEN', 'EXISTS', 'IN', 'LIKE', 'REGEXP', 'RLIKE']);
     }
     this.$ = { types: [ 'BOOLEAN' ] };
   
break;
case 1120: case 1122:
this.$ = { types: [ 'BOOLEAN' ], suggestFilters: $$[$0].suggestFilters };
break;
case 1121:

     parser.suggestFunctions();
     parser.suggestColumns();
     parser.suggestKeywords(['EXISTS']);
     this.$ = { types: [ 'BOOLEAN' ] };
   
break;
case 1123:

     parser.suggestFunctions({ types: [ 'BOOLEAN' ] });
     parser.suggestColumns({ types: [ 'BOOLEAN' ] });
     this.$ = { types: [ 'BOOLEAN' ] };
   
break;
case 1124:
this.$ = { types: [ 'T' ], suggestFilters: $$[$0].suggestFilters };
break;
case 1125:

     parser.suggestFunctions();
     parser.suggestColumns();
     this.$ = { types: [ 'T' ] };
   
break;
case 1126:

     if (!$$[$0].typeSet) {
       parser.applyTypeToSuggestions('NUMBER');
     }
     this.$ = { types: [ 'NUMBER' ], suggestFilters: $$[$0].suggestFilters };
   
break;
case 1127:

     parser.suggestFunctions({ types: [ 'NUMBER' ] });
     parser.suggestColumns({ types: [ 'NUMBER' ] });
     this.$ = { types: [ 'NUMBER' ] };
   
break;
case 1128:

     var keywords = ['FALSE', 'NOT NULL', 'NOT TRUE', 'NOT FALSE', 'NULL', 'TRUE'];
     if (parser.isImpala()) {
       keywords = keywords.concat(['DISTINCT FROM', 'NOT DISTINCT FROM', 'NOT UNKNOWN', 'UNKNOWN']);
     }
     parser.suggestKeywords(keywords);
     this.$ = { types: [ 'BOOLEAN' ] };
   
break;
case 1129:

     var keywords = ['FALSE', 'NULL', 'TRUE'];
     if (parser.isImpala()) {
       keywords = keywords.concat(['DISTINCT FROM', 'UNKNOWN']);
     }
     parser.suggestKeywords(keywords);
     this.$ = { types: [ 'BOOLEAN' ] };
   
break;
case 1130:

     if (parser.isImpala()) {
       parser.suggestKeywords(['FROM']);
     }
     this.$ = { types: [ 'BOOLEAN' ] };
   
break;
case 1131: case 1132: case 1133:

     parser.suggestKeywords(['NOT']);
     this.$ = { types: [ 'BOOLEAN' ] };
   
break;
case 1134:

     parser.valueExpressionSuggest($$[$0-5], $$[$0-3] ? 'IS NOT DISTINCT FROM' : 'IS DISTINCT FROM');
     this.$ = { types: [ 'BOOLEAN' ] };
   
break;
case 1135:

     this.$ = { types: [ 'BOOLEAN' ], suggestFilters: $$[$0].suggestFilters }
   
break;
case 1137:

     this.$ = $$[$0-1];
   
break;
case 1138:

     parser.valueExpressionSuggest();
     this.$ = { types: ['T'], typeSet: true };
   
break;
case 1139:

     parser.valueExpressionSuggest($$[$0], $$[$0-1]);
     parser.applyTypeToSuggestions($$[$0].types);
     this.$ = { types: [ 'BOOLEAN' ], typeSet: true };
   
break;
case 1140: case 1141: case 1142:

     parser.valueExpressionSuggest($$[$0], $$[$0-1]);
     parser.applyTypeToSuggestions($$[$0].types);
     this.$ = { types: [ 'BOOLEAN' ], typeSet: true  };
   
break;
case 1143: case 1144: case 1145: case 1146:

     if (!$$[$0-2].typeSet) {
       parser.applyTypeToSuggestions($$[$0].types);
       parser.addColRefIfExists($$[$0]);
     }
     this.$ = { types: [ 'BOOLEAN' ], suggestFilters: $$[$0-2].suggestFilters }
   
break;
case 1147: case 1149:

     parser.valueExpressionSuggest($$[$0-2], $$[$0-1]);
     parser.applyTypeToSuggestions($$[$0-2].types);
     this.$ = { types: [ 'BOOLEAN' ], typeSet: true  };
   
break;
case 1148:

     parser.valueExpressionSuggest($$[$0-2], $$[$0-1]);
     parser.applyTypeToSuggestions($$[$0-2].types);
     this.$ = { types: [ 'BOOLEAN' ] , typeSet: true, endsWithLessThanOrEqual: true };
   
break;
case 1150:

     parser.valueExpressionSuggest($$[$0-2], $$[$0-1]);
     parser.applyTypeToSuggestions($$[$0-2].types);
     this.$ = { types: [ 'BOOLEAN' ], typeSet: true, endsWithLessThanOrEqual: $$[$0-1] === '<='  };
   
break;
case 1151: case 1152: case 1153: case 1154:

     if (!$$[$0].typeSet) {
       parser.applyTypeToSuggestions($$[$0-2].types);
       parser.addColRefIfExists($$[$0-2]);
     }
     this.$ = { types: [ 'BOOLEAN' ], suggestFilters: $$[$0].suggestFilters }
   
break;
case 1155:

     if ($$[$0].inValueEdit) {
       parser.valueExpressionSuggest($$[$0-3], $$[$0-2] + ' ' + $$[$0-1]);
       parser.applyTypeToSuggestions($$[$0-3].types);
     }
     if ($$[$0].cursorAtStart) {
       parser.suggestKeywords(['SELECT']);
     }
     this.$ = { types: [ 'BOOLEAN' ], typeSet: true  };
   
break;
case 1156:

     if ($$[$0].inValueEdit) {
       parser.valueExpressionSuggest($$[$0-2], $$[$0-1]);
       parser.applyTypeToSuggestions($$[$0-2].types);
     }
     if ($$[$0].cursorAtStart) {
       parser.suggestKeywords(['SELECT']);
     }
     this.$ = { types: [ 'BOOLEAN' ], typeSet: true  };
   
break;
case 1157: case 1158:
this.$ = { types: [ 'BOOLEAN' ], suggestFilters: $$[$0-5].suggestFilters };
break;
case 1159: case 1160:
this.$ = { types: [ 'BOOLEAN' ], suggestFilters: $$[$0-4].suggestFilters };
break;
case 1161:

     if ($$[$0-2].types[0] === $$[$0].types[0] && !$$[$0-5].typeSet) {
       parser.applyTypeToSuggestions($$[$0-2].types);
     }
     this.$ = { types: [ 'BOOLEAN' ], suggestFilters: $$[$0-5].suggestFilters };
   
break;
case 1162:

     if ($$[$0-5].types[0] === $$[$0].types[0] && !$$[$0-2].typeSet) {
       parser.applyTypeToSuggestions($$[$0-5].types);
     }
     this.$ = { types: [ 'BOOLEAN' ], suggestFilters: $$[$0-2].suggestFilters };
   
break;
case 1163:

     if ($$[$0-5].types[0] === $$[$0-2].types[0] && !$$[$0].typeSet) {
       parser.applyTypeToSuggestions($$[$0-5].types);
     }
     this.$ = { types: [ 'BOOLEAN' ], suggestFilters: $$[$0].suggestFilters };
   
break;
case 1164:

     parser.valueExpressionSuggest($$[$0-5], $$[$0-1]);
     this.$ = { types: [ 'BOOLEAN' ], typeSet: true  };
   
break;
case 1165: case 1171:

     parser.suggestValueExpressionKeywords($$[$0-1], ['AND']);
     this.$ = { types: [ 'BOOLEAN' ] };
   
break;
case 1166:

     parser.valueExpressionSuggest($$[$0-3], $$[$0-2] + ' ' + $$[$0-1]);
     this.$ = { types: [ 'BOOLEAN' ], typeSet: true  };
   
break;
case 1167:

     if ($$[$0-4].types[0] === $$[$0-2].types[0] && !$$[$0-4].typeSet) {
       parser.applyTypeToSuggestions($$[$0-4].types)
     }
     this.$ = { types: [ 'BOOLEAN' ], suggestFilters: $$[$0-4].suggestFilters };
   
break;
case 1168:

     if ($$[$0-4].types[0] === $$[$0-2].types[0] && !$$[$0-2].typeSet) {
       parser.applyTypeToSuggestions($$[$0-4].types)
     }
     this.$ = { types: [ 'BOOLEAN' ], suggestFilters: $$[$0-2].suggestFilters };
   
break;
case 1169:

     if ($$[$0-4].types[0] === $$[$0-2].types[0] && !$$[$0].typeSet) {
       parser.applyTypeToSuggestions($$[$0-4].types)
     }
     this.$ = { types: [ 'BOOLEAN' ], suggestFilters: $$[$0].suggestFilters };
   
break;
case 1170:

     parser.valueExpressionSuggest($$[$0-4], $$[$0-1]);
     parser.applyTypeToSuggestions($$[$0-4].types);
     this.$ = { types: [ 'BOOLEAN' ], typeSet: true  };
   
break;
case 1172:

     parser.valueExpressionSuggest($$[$0-2], $$[$0-1]);
     parser.applyTypeToSuggestions($$[$0-2].types);
     this.$ = { types: [ 'BOOLEAN' ], typeSet: true };
   
break;
case 1173: case 1175: case 1177: case 1179:

     parser.valueExpressionSuggest(undefined, $$[$0-1]);
     this.$ = { types: [ 'BOOLEAN' ], typeSet: true, suggestFilters: true };
   
break;
case 1174: case 1178:

     parser.addColRefIfExists($$[$0]);
     this.$ = { types: [ 'BOOLEAN' ], suggestFilters: $$[$0-2].suggestFilters }
   
break;
case 1176: case 1180:

     parser.addColRefIfExists($$[$0-2]);
     this.$ = { types: [ 'BOOLEAN' ], suggestFilters: $$[$0].suggestFilters }
   
break;
case 1181: case 1182:

     parser.valueExpressionSuggest(undefined, $$[$0-1]);
     parser.applyTypeToSuggestions([ 'NUMBER' ]);
     this.$ = { types: [ 'NUMBER' ], typeSet: true };
   
break;
case 1183: case 1184: case 1185:

     if (!$$[$0-2].typeSet) {
       parser.applyTypeToSuggestions(['NUMBER']);
       parser.addColRefIfExists($$[$0]);
     }
     this.$ = { types: [ 'NUMBER' ], suggestFilters: $$[$0-2].suggestFilters }
   
break;
case 1186: case 1187: case 1188:

     parser.valueExpressionSuggest(undefined, $$[$0-1]);
     parser.applyTypeToSuggestions(['NUMBER']);
     this.$ = { types: [ 'NUMBER' ], typeSet: true };
   
break;
case 1189: case 1190: case 1191:

     if (!$$[$0].typeSet) {
       parser.applyTypeToSuggestions(['NUMBER']);
       parser.addColRefIfExists($$[$0-2]);
     }
     this.$ = { types: [ 'NUMBER' ], suggestFilters: $$[$0].suggestFilters };
   
break;
case 1192:
this.$ = { types: [ 'BOOLEAN' ], suggestFilters: $$[$0-1].suggestFilters };
break;
case 1193:
this.$ = { types: [ 'BOOLEAN' ], suggestFilters: $$[$0-2].suggestFilters };
break;
case 1196:

     parser.valueExpressionSuggest(undefined, $$[$0]);
     parser.applyTypeToSuggestions([ 'STRING' ]);
     this.$ = { types: [ 'BOOLEAN' ], typeSet: true };
   
break;
case 1197:

     parser.valueExpressionSuggest(undefined, $$[$0-1] + ' ' + $$[$0]);
     parser.applyTypeToSuggestions([ 'STRING' ]);
     this.$ = { types: [ 'BOOLEAN' ], typeSet: true };
   
break;
case 1199:

     parser.valueExpressionSuggest();
     parser.suggestKeywords(['WHEN']);
     this.$ = { types: [ 'T' ], typeSet: true };
   
break;
case 1201:

     parser.suggestValueExpressionKeywords($$[$0-2], ['WHEN']);
     this.$ = { types: [ 'T' ], typeSet: true };
   
break;
case 1202:

      this.$ = $$[$0];
      this.$.suggestFilters = $$[$0-1].suggestFilters;
    
break;
case 1203:
this.$ = { types: [ 'T' ], suggestFilters: $$[$0-1].suggestFilters };
break;
case 1204: case 1536: case 1541: case 1542:
this.$ = { types: [ 'T' ] };
break;
case 1205: case 1207:

     $$[$0].position = 1;
   
break;
case 1206:

     $$[$0].position = $$[$0-2].position + 1;
     this.$ = $$[$0];
   
break;
case 1208:

     $$[$0-2].position += 1;
   
break;
case 1209:

     $$[$0-2].position = 1;
   
break;
case 1210:

     $$[$0-4].position += 1;
   
break;
case 1211:

     parser.valueExpressionSuggest();
     $$[$0-2].position += 1;
   
break;
case 1212:

     parser.valueExpressionSuggest();
     $$[$0-4].position += 1;
   
break;
case 1213:

     parser.suggestValueExpressionKeywords($$[$0-3]);
   
break;
case 1214: case 1215:

     parser.valueExpressionSuggest();
     this.$ = { cursorAtStart : true, position: 1 };
   
break;
case 1216: case 1217:

     parser.valueExpressionSuggest();
     this.$ = { position: 2 };
   
break;
case 1221:
this.$ = { types: ['COLREF'], columnReference: $$[$0].chain };
break;
case 1222:

     // We need to handle arbitrary UDFs here instead of inside UserDefinedFunction or there will be a conflict
     // with columnReference for functions like: db.udf(foo)
     var fn = $$[$0-1].chain[$$[$0-1].chain.length - 1].name.toLowerCase(); 
     $$[$0-1].lastLoc.type = 'function';
     $$[$0-1].lastLoc.function = fn;
     if($$[$0-1].lastLoc.location){
        $$[$0-1].lastLoc.location = {
            first_line: $$[$0-1].lastLoc.location.first_line,
            last_line: $$[$0-1].lastLoc.location.last_line,
            first_column: $$[$0-1].lastLoc.location.first_column,
            last_column: $$[$0-1].lastLoc.location.last_column - 1
        }  
     }
     if ($$[$0-1].lastLoc !== $$[$0-1].firstLoc) {
        $$[$0-1].firstLoc.type = 'database';
     } else {
       delete $$[$0-1].lastLoc.identifierChain;
     }
     if ($$[$0].expression) {
       this.$ = { function: fn, expression: $$[$0].expression, types: parser.findReturnTypes(fn) }
     } else {
       this.$ = { function: fn, types: parser.findReturnTypes(fn) }
     }
   
break;
case 1223:

    parser.addFunctionLocation(_$[$0-1], $$[$0-1]);
    if ($$[$0].expression) {
      this.$ = { function: $$[$0-1], expression: $$[$0].expression, types: parser.findReturnTypes($$[$0-1]) }
    } else {
      this.$ = { function: $$[$0-1], types: parser.findReturnTypes($$[$0-1]) }
    }
  
break;
case 1225:
this.$ = { types: [ 'NULL' ] };
break;
case 1226:
this.$ = { types: [ 'TIMESTAMP' ] };
break;
case 1228:

     if ($$[$0].suggestKeywords) {
       this.$ = { types: ['COLREF'], columnReference: $$[$0], suggestKeywords: $$[$0].suggestKeywords };
     } else {
       this.$ = { types: ['COLREF'], columnReference: $$[$0] };
     }
   
break;
case 1229:

     var fn = $$[$0-1].chain[$$[$0-1].chain.length - 1].name.toLowerCase();
     $$[$0-1].lastLoc.type = 'function';
     $$[$0-1].lastLoc.function = fn;
     $$[$0-1].lastLoc.location = {
       first_line: $$[$0-1].lastLoc.location.first_line,
       last_line: $$[$0-1].lastLoc.location.last_line,
       first_column: $$[$0-1].lastLoc.location.first_column,
       last_column: $$[$0-1].lastLoc.location.last_column - 1
     }
     if ($$[$0-1].lastLoc !== $$[$0-1].firstLoc) {
        $$[$0-1].firstLoc.type = 'database';
     } else {
       delete $$[$0-1].lastLoc.identifierChain;
     }
     if ($$[$0].position) {
       parser.applyArgumentTypesToSuggestions(fn, $$[$0].position);
     }
     this.$ = { types: parser.findReturnTypes(fn) };
   
break;
case 1230: case 1438: case 1439:

     parser.addFunctionLocation(_$[$0-1], $$[$0-1]);
     if ($$[$0].position) {
       parser.applyArgumentTypesToSuggestions($$[$0-1], $$[$0].position);
     }
     this.$ = { types: parser.findReturnTypes($$[$0-1]) };
   
break;
case 1233:

     var lastLoc = parser.yy.locations[parser.yy.locations.length - 1];
     if (lastLoc.type !== 'variable') {
       lastLoc.type = 'column';
     }
     // used for function references with db prefix
     var firstLoc = parser.yy.locations[parser.yy.locations.length - $$[$0].length];
     this.$ = { chain: $$[$0], firstLoc: firstLoc, lastLoc: lastLoc }
   
break;
case 1237:

     parser.suggestKeywords(['DAYS', 'HOURS', 'MICROSECONDS', 'MILLISECONDS', 'MINUTES', 'MONTHS', 'NANOSECONDS', 'SECONDS', 'WEEKS', 'YEARS']);
   
break;
case 1242:

     parser.suggestValues($$[$0]);
   
break;
case 1243:
this.$ = { types: [ 'NUMBER' ] };
break;
case 1249: case 1251:
this.$ = $$[$0-1] + $$[$0];
break;
case 1250:
this.$ = $$[$0-2] + $$[$0-1] + $$[$0];
break;
case 1255: case 1256:

     if (/\$\{[^}]*\}/.test($$[$0])) {
       parser.addVariableLocation(_$[$0], $$[$0]);
       this.$ = { types: [ 'STRING' ], columnReference: [{ name: $$[$0] }] }
     } else {
       this.$ = { types: [ 'STRING' ] }
     }
   
break;
case 1258:

    this.$ = { partialQuote: '\'', missingEndQuote: parser.yy.missingEndQuote };
  
break;
case 1259:

    this.$ = { partialQuote: '"', missingEndQuote: parser.yy.missingEndQuote };
  
break;
case 1264:

     if ($$[$0]) {
       parser.addColumnAliasLocation($$[$0].location, $$[$0].alias, _$[$0-1]);
       this.$ = { valueExpression: $$[$0-1], alias: $$[$0].alias };
       if (!parser.yy.selectListAliases) {
         parser.yy.selectListAliases = [];
       }
       parser.yy.selectListAliases.push({ name: $$[$0].alias, types: $$[$0-1].types || ['T'] });
     } else {
       this.$ = { valueExpression: $$[$0-1] }
     }
   
break;
case 1265:

     parser.addAsteriskLocation(_$[$0], [{ asterisk: true }]);
     this.$ = { asterisk: true }
   
break;
case 1266:

     if ($$[$0]) {
       parser.addColumnAliasLocation($$[$0].location, $$[$0].alias, _$[$0-1]);
     }
   
break;
case 1267:

     parser.suggestFunctions();
     parser.suggestColumns();
     parser.addColumnAliasLocation(_$[$0], $$[$0], _$[$0-2]);
     this.$ = { suggestAggregateFunctions: true };
   
break;
case 1269: case 1635:
this.$ = [ $$[$0] ];
break;
case 1270:

     $$[$0-2].push($$[$0]);
   
break;
case 1272: case 1273: case 1709:

     this.$ = { cursorAtStart : true, suggestFunctions: true, suggestColumns: true, suggestAggregateFunctions: true };
   
break;
case 1275:

     parser.checkForSelectListKeywords($$[$0-2]);
   
break;
case 1276:

     parser.checkForSelectListKeywords($$[$0-3]);
   
break;
case 1277:

     this.$ = { suggestKeywords: parser.getSelectListKeywords(), suggestTables: true, suggestDatabases: true, suggestFunctions: true, suggestColumns: true, suggestAggregateFunctions: true };
   
break;
case 1279: case 1280: case 1282:

     this.$ = { suggestKeywords: parser.getSelectListKeywords(), suggestFunctions: true, suggestColumns: true, suggestAggregateFunctions: true,  };
   
break;
case 1293:

     this.$ = $$[$0];

     if (parser.yy.latestTablePrimaries.length > 0) {
       var idx = parser.yy.latestTablePrimaries.length - 1;
       var tables = [];
       do {
         var tablePrimary = parser.yy.latestTablePrimaries[idx];
         if (!tablePrimary.subQueryAlias) {
           tables.unshift(tablePrimary.alias ? { identifierChain: tablePrimary.identifierChain, alias: tablePrimary.alias } : { identifierChain: tablePrimary.identifierChain })
         }
         idx--;
       } while (idx >= 0 && tablePrimary.join && !tablePrimary.subQueryAlias)

       if (tables.length > 0) {
         this.$.suggestJoins = {
           prependJoin: true,
           tables: tables
         };
       }
      }
   
break;
case 1300:

     if ($$[$0] && $$[$0].valueExpression) {
       this.$ = $$[$0].valueExpression;
     } else {
       this.$ = {};
     }
     this.$.joinType = $$[$0-3];
     if ($$[$0].noJoinCondition) {
       this.$.suggestJoinConditions = { prependOn: true, tablePrimaries: parser.yy.latestTablePrimaries.concat() }
     }
     if ($$[$0].suggestKeywords) {
       this.$.suggestKeywords = $$[$0].suggestKeywords;
     }
     if (parser.yy.latestTablePrimaries.length > 0) {
        parser.yy.latestTablePrimaries[parser.yy.latestTablePrimaries.length - 1].join = true;
     }
   
break;
case 1301:

     if ($$[$0] && $$[$0].valueExpression) {
       this.$ = $$[$0].valueExpression;
     } else {
       this.$ = {};
     }
     this.$.joinType = $$[$0-4];
     if ($$[$0].noJoinCondition) {
       this.$.suggestJoinConditions = { prependOn: true, tablePrimaries: parser.yy.latestTablePrimaries.concat() }
     }
     if ($$[$0].suggestKeywords) {
       this.$.suggestKeywords = $$[$0].suggestKeywords;
     }
     if (parser.yy.latestTablePrimaries.length > 0) {
       parser.yy.latestTablePrimaries[parser.yy.latestTablePrimaries.length - 1].join = true;
     }
   
break;
case 1302:
this.$ = { joinType: $$[$0-1] };
break;
case 1303:
this.$ = { joinType: $$[$0-2] };
break;
case 1307:

     if ($$[$0-3].suggestKeywords) {
       parser.suggestKeywords($$[$0-3].suggestKeywords);
     }
   
break;
case 1308: case 1893:

     if ($$[$0-1].suggestKeywords) {
       parser.suggestKeywords($$[$0-1].suggestKeywords);
     }
   
break;
case 1311:

     if (!$$[$0-2] && parser.isImpala()) {
       parser.suggestKeywords(['[BROADCAST]', '[SHUFFLE]']);
     }
     if (!$$[$0-2] && parser.yy.latestTablePrimaries.length > 0) {
       var idx = parser.yy.latestTablePrimaries.length - 1;
       var tables = [];
       do {
         var tablePrimary = parser.yy.latestTablePrimaries[idx];
         if (!tablePrimary.subQueryAlias) {
           tables.unshift(tablePrimary.alias ? { identifierChain: tablePrimary.identifierChain, alias: tablePrimary.alias } : { identifierChain: tablePrimary.identifierChain })
         }
         idx--;
       } while (idx >= 0 && tablePrimary.join && !tablePrimary.subQueryAlias)

       if (tables.length > 0) {
         parser.suggestJoins({
           prependJoin: false,
           joinType: $$[$0-3],
           tables: tables
         })
       }
     }
     parser.suggestTables();
     parser.suggestDatabases({
       appendDot: true
     });
   
break;
case 1316:
this.$ = 'JOIN';
break;
case 1317:
this.$ = 'ANTI JOIN';
break;
case 1318:
this.$ = 'CROSS JOIN';
break;
case 1319:
this.$ = 'INNER JOIN';
break;
case 1320:
this.$ = 'OUTER JOIN';
break;
case 1321:
this.$ = 'SEMI JOIN';
break;
case 1322:
this.$ = 'FULL JOIN';
break;
case 1323:
this.$ = 'FULL OUTER JOIN';
break;
case 1324:
this.$ = 'LEFT JOIN';
break;
case 1325:
this.$ = 'LEFT ANTI JOIN';
break;
case 1326:
this.$ = 'LEFT INNER JOIN';
break;
case 1327:
this.$ = 'LEFT OUTER JOIN';
break;
case 1328:
this.$ = 'LEFT SEMI JOIN';
break;
case 1329:
this.$ = 'RIGHT JOIN';
break;
case 1330:
this.$ = 'RIGHT ANTI JOIN';
break;
case 1331: case 1332:
this.$ = 'RIGHT OUTER JOIN';
break;
case 1333:
this.$ = 'RIGHT SEMI JOIN';
break;
case 1334: case 1335: case 1336: case 1337: case 1338: case 1339: case 1341: case 1342: case 1343: case 1344: case 1346: case 1347: case 1348: case 1349:
this.$ = { suggestKeywords: ['JOIN'] };
break;
case 1340:
this.$ = { suggestKeywords: ['OUTER'] };
break;
case 1345:
this.$ = { suggestKeywords: parser.isImpala() ? ['ANTI', 'INNER', 'OUTER', 'SEMI'] : parser.isHive() ? ['OUTER', 'SEMI'] : ['OUTER'] };
break;
case 1350:
this.$ = { suggestKeywords: parser.isImpala() ? ['ANTI', 'INNER', 'OUTER', 'SEMI'] : ['OUTER'] };
break;
case 1351:

     parser.suggestKeywords(['JOIN', 'OUTER JOIN']);
   
break;
case 1352:

     if (parser.isHive()) {
       parser.suggestKeywords(['JOIN', 'OUTER JOIN', 'SEMI JOIN']);
     } else if (parser.isImpala()) {
       parser.suggestKeywords(['ANTI JOIN', 'INNER JOIN', 'JOIN', 'OUTER JOIN', 'SEMI JOIN']);
     } else {
       parser.suggestKeywords(['JOIN', 'OUTER JOIN']);
     }
   
break;
case 1353:

     if (parser.isImpala()) {
       parser.suggestKeywords(['ANTI JOIN', 'INNER JOIN', 'JOIN', 'OUTER JOIN', 'SEMI JOIN']);
     } else {
       parser.suggestKeywords(['JOIN', 'OUTER JOIN']);
     }
   
break;
case 1354:
this.$ = { noJoinCondition: true, suggestKeywords: parser.isImpala() ? ['ON', 'USING'] : ['ON'] };
break;
case 1355:
this.$ = { valueExpression: $$[$0] };
break;
case 1356: case 2183:
this.$ = {};
break;
case 1360:

     parser.valueExpressionSuggest();
     parser.suggestJoinConditions({ prependOn: false });
   
break;
case 1361:

     this.$ = {
       primary: $$[$0-3]
     }
     if ($$[$0-3].identifierChain) {
       if ($$[$0-1]) {
         $$[$0-3].alias = $$[$0-1].alias
         parser.addTableAliasLocation($$[$0-1].location, $$[$0-1].alias, $$[$0-3].identifierChain);
       }
       parser.addTablePrimary($$[$0-3]);
     }
     var keywords = [];
     if ($$[$0] && $$[$0].suggestKeywords) {
       keywords = $$[$0].suggestKeywords;
     } else {
       // Right-to-left for cursor after TablePrimary
       keywords = parser.getKeywordsForOptionalsLR([$$[$0], $$[$0-1], $$[$0-2]], [{ value: 'TABLESAMPLE', weight: 1 }, { value: 'AS', weight: 2 }, { value: 'TABLESAMPLE', weight: 3 }], [parser.isImpala(), true, parser.isHive()]);
     }
     if (keywords.length > 0) {
       this.$.suggestKeywords = keywords;
     }
   
break;
case 1362:

     this.$ = {
       primary: $$[$0-2]
     };

     if ($$[$0-1]) {
       if(this.$.primary){
          this.$.primary.alias = $$[$0-1].alias;
          parser.addTablePrimary({ subQueryAlias: $$[$0-1].alias });
          parser.addSubqueryAliasLocation($$[$0-1].location, $$[$0-1].alias, $$[$0-2].identifierChain);
       }
     }

     var keywords = [];
     if ($$[$0] && $$[$0].suggestKeywords) {
       keywords = $$[$0].suggestKeywords;
     } else {
       keywords = parser.getKeywordsForOptionalsLR([$$[$0], $$[$0-1]], [{ value: 'TABLESAMPLE', weight: 1 }, { value: 'AS', weight: 2 }], [parser.isImpala(), true]);
     }
     if (keywords.length > 0) {
       this.$.suggestKeywords = keywords;
     }
   
break;
case 1363:

     if ($$[$0-1]) {
       parser.addTableAliasLocation($$[$0-1].location, $$[$0-1].alias, $$[$0-3].identifierChain);
     }
   
break;
case 1364: case 1365:

     if ($$[$0-1]) {
       $$[$0-3].alias = $$[$0-1].alias;
       parser.addTableAliasLocation($$[$0-1].location, $$[$0-1].alias, $$[$0-3].identifierChain);
     }
     parser.addTablePrimary($$[$0-3]);
   
break;
case 1366:

     if ($$[$0-1]) {
       parser.addTablePrimary({ subQueryAlias: $$[$0-1].alias });
       parser.addSubqueryAliasLocation($$[$0-1].location, $$[$0-1].alias);
     }
   
break;
case 1377:

     parser.suggestKeywords(['BUCKET']);
   
break;
case 1378:

     parser.suggestKeywords(['OUT OF']);
   
break;
case 1379:

     parser.suggestKeywords(['OF']);
   
break;
case 1380:

     if (!$$[$0-2]) {
       parser.suggestKeywords(['ON']);
     }
   
break;
case 1382:

     if ($$[$0-2].indexOf('.') === -1 ) {
       parser.suggestKeywords(['PERCENT', 'ROWS']);
     } else {
       parser.suggestKeywords(['PERCENT']);
     }
   
break;
case 1384:
this.$ = { suggestKeywords: ['REPEATABLE()'] };
break;
case 1386:

     parser.suggestKeywords(['SYSTEM()']);
   
break;
case 1391:

     parser.pushQueryState();
   
break;
case 1392:

     parser.popQueryState();
   
break;
case 1394:

     if ($$[$0-1]) {
       $$[$0-2].alias = $$[$0-1].alias;
       parser.addTablePrimary({ subQueryAlias: $$[$0-1].alias });
       parser.addSubqueryAliasLocation($$[$0-1].location, $$[$0-1].alias, $$[$0-2].identifierChain);
     }
     this.$ = $$[$0-2];
   
break;
case 1397:

     var subQuery = parser.getSubQuery($$[$0]);
     if(subQuery){
        subQuery.columns.forEach(function (column) {
        parser.expandIdentifierChain({ wrapper: column });
        delete column.linked;
     });
     }
     parser.popQueryState(subQuery);
     this.$ = subQuery;
   
break;
case 1414: case 1415:
this.$ = { alias: $$[$0], location: _$[$0] };
break;
case 1420:

     if ($$[$0-1] && $$[$0].lateralView) {
       $$[$0-1].lateralViews.push($$[$0].lateralView);
       this.$ = $$[$0-1];
     } else if ($$[$0].lateralView) {
       this.$ = { lateralViews: [ $$[$0].lateralView ] };
     }
     if ($$[$0].suggestKeywords) {
       this.$.suggestKeywords = $$[$0].suggestKeywords
     }
   
break;
case 1422:

     if (!$$[$0]) {
       $$[$0-1].suggestKeywords = ['OVER'];
     }
   
break;
case 1431:

     parser.suggestKeywords(['OVER']);
   
break;
case 1436: case 1437:

     parser.addFunctionLocation(_$[$0-1], $$[$0-1]);
     if ($$[$0].expression) {
       this.$ = { function: $$[$0-1], expression: $$[$0].expression, types: parser.findReturnTypes($$[$0-1]) }
     } else {
       this.$ = { function: $$[$0-1], types: parser.findReturnTypes($$[$0-1]) }
     }
   
break;
case 1450:
this.$ = { expression: $$[$0-2] };
break;
case 1451:

     parser.valueExpressionSuggest();
     this.$ = { position: 1 }
   
break;
case 1452:

     parser.suggestValueExpressionKeywords($$[$0-1]);
   
break;
case 1460: case 1548: case 1614:
this.$ = { types: parser.findReturnTypes($$[$0-2]) };
break;
case 1461:
this.$ = { function: $$[$0-3], expression: $$[$0-2], types: parser.findReturnTypes($$[$0-3]) };
break;
case 1462:

     parser.valueExpressionSuggest();
     parser.applyArgumentTypesToSuggestions($$[$0-3], 1);
     this.$ = { types: parser.findReturnTypes($$[$0-3]) };
   
break;
case 1463:

     parser.suggestValueExpressionKeywords($$[$0-2]);
     this.$ = { types: parser.findReturnTypes($$[$0-4]) };
   
break;
case 1464:

     parser.applyArgumentTypesToSuggestions($$[$0-3], $$[$0-1].position);
     this.$ = { types: parser.findReturnTypes($$[$0-3]) };
   
break;
case 1472: case 1473:

     if (parser.yy.result.suggestFunctions) {
       parser.suggestAggregateFunctions();
     }
   
break;
case 1474:

     if (!$$[$0-2] && !$$[$0-1]) {
       parser.suggestKeywords([{ value: 'PARTITION BY', weight: 2 }, { value: 'ORDER BY', weight: 1 }]);
     } else if (!$$[$0-2]) {
       parser.suggestKeywords(['PARTITION BY']);
     }
   
break;
case 1475:

      if (!$$[$0-1]) {
        parser.suggestValueExpressionKeywords($$[$0-3], [{ value: 'ORDER BY', weight: 2 }]);
      } else {
        parser.suggestValueExpressionKeywords($$[$0-3]);
      }
    
break;
case 1479: case 1824: case 2302: case 2303: case 2306: case 2316: case 2350: case 2359: case 2377: case 2434: case 2435: case 2440: case 2445: case 2449:

     parser.suggestKeywords(['BY']);
   
break;
case 1484:

      // Only allowed in last order by
      delete parser.yy.result.suggestAnalyticFunctions;
    
break;
case 1485:

      var keywords = [];
      if ($$[$0-2].suggestKeywords) {
        keywords = parser.createWeightedKeywords($$[$0-2].suggestKeywords, 2);
      }
      if (!$$[$0]) {
        keywords = keywords.concat([{ value: 'RANGE BETWEEN', weight: 1 }, { value: 'ROWS BETWEEN', weight: 1 }]);
      }
      parser.suggestKeywords(keywords);
    
break;
case 1491:

     parser.suggestKeywords(parser.isHive() ? ['BETWEEN', 'UNBOUNDED'] : ['BETWEEN']);
   
break;
case 1492:

     if (!$$[$0-2] && !$$[$0-1]) {
       parser.suggestKeywords(['CURRENT ROW', 'UNBOUNDED PRECEDING']);
     } else if (!$$[$0-1]) {
       parser.suggestKeywords(['AND']);
     }
   
break;
case 1495:

     if (!$$[$0-1] && parser.isHive()) {
       parser.suggestKeywords(['PRECEDING']);
     }
   
break;
case 1497:

    lexer.popState();
  
break;
case 1498:

    lexer.begin('hdfs');
  
break;
case 1500:

      parser.suggestHdfs({ path: $$[$0-3] });
    
break;
case 1501:

     parser.suggestHdfs({ path: $$[$0-2] });
   
break;
case 1502:

      parser.suggestHdfs({ path: $$[$0-1] });
    
break;
case 1503:

     parser.suggestHdfs({ path: '' });
   
break;
case 1504:

      parser.suggestHdfs({ path: '' });
    
break;
case 1510:

     parser.suggestKeywords(['PRECEDING']);
   
break;
case 1511: case 1521:

     parser.suggestKeywords(['ROW']);
   
break;
case 1520:

     parser.suggestKeywords(['CURRENT ROW', 'UNBOUNDED FOLLOWING']);
   
break;
case 1522:

     parser.suggestKeywords(['FOLLOWING']);
   
break;
case 1528:

     parser.valueExpressionSuggest();
     parser.suggestAggregateFunctions();
     parser.suggestSelectListAliases(true);
   
break;
case 1529:

     parser.suggestAggregateFunctions();
     parser.suggestSelectListAliases(true);
   
break;
case 1535: case 1540:
this.$ = { types: [ $$[$0-1].toUpperCase() ] };
break;
case 1537:

     parser.valueExpressionSuggest();
     this.$ = { types: [ $$[$0-1].toUpperCase() ] };
   
break;
case 1538: case 1539:

     parser.valueExpressionSuggest();
     this.$ = { types: [ 'T' ] };
   
break;
case 1543:

     parser.suggestValueExpressionKeywords($$[$0-3], [{ value: 'AS', weight: 2 }]);
     this.$ =  { types: [ $$[$0-1].toUpperCase() ] };
   
break;
case 1544:

     parser.suggestValueExpressionKeywords($$[$0-2], [{ value: 'AS', weight: 2 }]);
     this.$ = { types: [ 'T' ] };
   
break;
case 1545: case 1546:

     parser.suggestKeywords(parser.getTypeKeywords());
     this.$ = { types: [ 'T' ] };
   
break;
case 1547: case 1569:
this.$ = { types: parser.findReturnTypes($$[$0-3]) };
break;
case 1549: case 1570: case 1613:
this.$ = { types: parser.findReturnTypes($$[$0-4]) };
break;
case 1550:

     parser.valueExpressionSuggest();
     var keywords = parser.getSelectListKeywords();
     if (!$$[$0-2]) {
       keywords.push('DISTINCT');
       if (parser.isImpala()) {
         keywords.push('ALL');
       }
       if (parser.yy.result.suggestKeywords) {
         keywords = parser.yy.result.suggestKeywords.concat(keywords);
       }
     }
     parser.suggestKeywords(keywords);
     this.$ = { types: parser.findReturnTypes($$[$0-4]) };
   
break;
case 1551: case 1572: case 1616:

     parser.suggestValueExpressionKeywords($$[$0-2]);
     this.$ = { types: parser.findReturnTypes($$[$0-5]) };
   
break;
case 1552:

     if ($$[$0-1].cursorAtStart) {
       var keywords = parser.getSelectListKeywords();
       if (!$$[$0-2]) {
         keywords.push('DISTINCT');
         if (parser.isImpala()) {
           keywords.push('ALL');
         }
       }
       parser.suggestKeywords(keywords);
     }
     this.$ = { types: parser.findReturnTypes($$[$0-4]) };
   
break;
case 1553: case 1557:
this.$ = { types: ['INT'] };
break;
case 1554:

     parser.suggestKeywords(['DAY', 'DAYOFWEEK', 'HOUR', 'MINUTE', 'MONTH', 'QUARTER', 'SECOND', 'WEEK', 'YEAR']);
     this.$ = { types: ['INT'] }
   
break;
case 1555: case 1559:

     parser.suggestKeywords(['FROM']);
     this.$ = { types: ['INT'] }
   
break;
case 1556:

     parser.valueExpressionSuggest();
     this.$ = { types: ['INT'] }
   
break;
case 1558:

      parser.suggestKeywords(['DAY', 'DAYOFWEEK', 'HOUR', 'MINUTE', 'MONTH', 'QUARTER', 'SECOND', 'WEEK', 'YEAR']);
      this.$ = { types: ['INT'] }
   
break;
case 1571:

     parser.valueExpressionSuggest();
     var keywords = parser.getSelectListKeywords(true);
     if (!$$[$0-2]) {
       if ($$[$0-4].toLowerCase() === 'group_concat') {
         keywords.push('ALL');
       } else if (parser.isImpala()) {
         keywords.push('ALL');
         keywords.push('DISTINCT');
       } else {
         keywords.push('DISTINCT');
       }
     }
     if (parser.yy.result.suggestKeywords) {
       keywords = parser.yy.result.suggestKeywords.concat(keywords);
     }
     parser.suggestKeywords(keywords);
     parser.applyArgumentTypesToSuggestions($$[$0-4], 1);
     this.$ = { types: parser.findReturnTypes($$[$0-4]) };
   
break;
case 1573:

     if ($$[$0-1].cursorAtStart) {
       var keywords = parser.getSelectListKeywords(true);
       if (!$$[$0-2]) {
         if ($$[$0-4].toLowerCase() === 'group_concat') {
           keywords.push('ALL');
         } else if (parser.isImpala()) {
           keywords.push('ALL');
           keywords.push('DISTINCT');
         } else {
           keywords.push('DISTINCT');
         }
       }
       if (parser.yy.result.suggestKeywords) {
         keywords = parser.yy.result.suggestKeywords.concat(keywords);
       }
       parser.suggestKeywords(keywords);
     }
     if (parser.yy.result.suggestFunctions && !parser.yy.result.suggestFunctions.types) {
       parser.applyArgumentTypesToSuggestions($$[$0-4], $$[$0-1].position);
     }
     this.$ = { types: parser.findReturnTypes($$[$0-4]) };
   
break;
case 1599:

     parser.valueExpressionSuggest();
     parser.applyTypeToSuggestions($$[$0-2].toLowerCase() === 'from' ? ['STRING'] : ['TIMESTAMP']);
     this.$ = { types: parser.findReturnTypes($$[$0-5]) };
   
break;
case 1600:

     parser.valueExpressionSuggest();
     parser.applyTypeToSuggestions($$[$0-1].toLowerCase() === 'from' ? ['STRING'] : ['TIMESTAMP']);
     this.$ = { types: parser.findReturnTypes($$[$0-4]) };
   
break;
case 1601:

     parser.valueExpressionSuggest();
     parser.applyTypeToSuggestions(['STRING', 'TIMESTAMP']);
     this.$ = { types: parser.findReturnTypes($$[$0-3]) };
   
break;
case 1602:

     parser.applyTypeToSuggestions($$[$0-2].toLowerCase() === 'from' ? ['STRING'] : ['TIMESTAMP']);
     this.$ = { types: parser.findReturnTypes($$[$0-5]) };
   
break;
case 1603:

     parser.applyTypeToSuggestions($$[$0-1].toLowerCase() === 'from' ? ['STRING'] : ['TIMESTAMP']);
     this.$ = { types: parser.findReturnTypes($$[$0-4]) };
   
break;
case 1604:

     parser.applyTypeToSuggestions(['STRING', 'TIMESTAMP']);
     this.$ = { types: parser.findReturnTypes($$[$0-3]) };
   
break;
case 1605:

     parser.valueExpressionSuggest();
     parser.applyTypeToSuggestions($$[$0-2].toLowerCase() === 'from' ? ['TIMESTAMP'] : ['STRING']);
     this.$ = { types: parser.findReturnTypes($$[$0-5]) };
   
break;
case 1606:

     parser.valueExpressionSuggest();
     parser.applyTypeToSuggestions($$[$0-1].toLowerCase() === 'from' ? ['TIMESTAMP'] : ['STRING']);
     this.$ = { types: parser.findReturnTypes($$[$0-4]) };
   
break;
case 1607:

     parser.applyTypeToSuggestions($$[$0-2].toLowerCase() === 'from' ? ['TIMESTAMP'] : ['STRING']);
     this.$ = { types: parser.findReturnTypes($$[$0-5]) };
   
break;
case 1608:

    parser.applyTypeToSuggestions($$[$0-1].toLowerCase() === 'from' ? ['TIMESTAMP'] : ['STRING']);
     this.$ = { types: parser.findReturnTypes($$[$0-4]) };
   
break;
case 1609:

     if ($$[$0-3].types[0] === 'STRING') {
       parser.suggestValueExpressionKeywords($$[$0-3], ['FROM']);
     } else {
       parser.suggestValueExpressionKeywords($$[$0-3]);
     }
     this.$ = { types: parser.findReturnTypes($$[$0-5]) };
   
break;
case 1610:

     if ($$[$0-2].types[0] === 'STRING') {
       parser.suggestValueExpressionKeywords($$[$0-2], ['FROM']);
     } else {
       parser.suggestValueExpressionKeywords($$[$0-2]);
     }
     this.$ = { types: parser.findReturnTypes($$[$0-4]) };
   
break;
case 1615:

     parser.valueExpressionSuggest();
     parser.applyArgumentTypesToSuggestions($$[$0-4], 1);
     var keywords = parser.getSelectListKeywords(true);
     if (!$$[$0-2]) {
       keywords.push('DISTINCT');
       if (parser.isImpala()) {
         keywords.push('ALL');
       }
     }
     if (parser.yy.result.suggestKeywords) {
       keywords = parser.yy.result.suggestKeywords.concat(keywords);
     }
     parser.suggestKeywords(keywords);
     this.$ = { types: parser.findReturnTypes($$[$0-4]) };
   
break;
case 1617:

     if (parser.yy.result.suggestFunctions && ! parser.yy.result.suggestFunctions.types) {
       parser.applyArgumentTypesToSuggestions($$[$0-4], 1);
     }
     this.$ = { types: parser.findReturnTypes($$[$0-4]) };
   
break;
case 1618:
this.$ = { lateralView: { udtf: $$[$0-2], tableAlias: $$[$0-1], columnAliases: $$[$0] }};
break;
case 1619:

     if ($$[$0-1].function.toLowerCase() === 'explode') {
       this.$ = { lateralView: { udtf: $$[$0-1], tableAlias: $$[$0], columnAliases: ['key', 'value'] }, suggestKeywords: ['AS'] };
     } else if ($$[$0-1].function.toLowerCase() === 'posexplode') {
       this.$ = { lateralView: { udtf: $$[$0-1], tableAlias: $$[$0], columnAliases: ['pos', 'val'] }, suggestKeywords: ['AS'] };
     } else {
       this.$ = { lateralView: { udtf: $$[$0-1], tableAlias: $$[$0], columnAliases: [] }, suggestKeywords: ['AS'] };
     }
   
break;
case 1620:
this.$ = { lateralView: { udtf: $$[$0-1], columnAliases: $$[$0] }};
break;
case 1621: case 1622: case 1623: case 1624:
this.$ = { };
break;
case 1631:

     if (!$$[$0-1]) {
       parser.suggestKeywords([{ value: 'OUTER', weight: 2 }, { value: 'explode', weight: 1 }, { value: 'posexplode', weight: 1 }]);
     } else {
       parser.suggestKeywords(['explode', 'posexplode']);
     }
   
break;
case 1632:

     parser.suggestKeywords(['VIEW']);
   
break;
case 1636:
this.$ = [ $$[$0-2], $$[$0] ];
break;
case 1640:
this.$ = { inValueEdit: true };
break;
case 1641:
this.$ = { inValueEdit: true, cursorAtStart: true };
break;
case 1642: case 1643: case 1644: case 1645: case 1646:
this.$ = { suggestKeywords: ['NOT'] };
break;
case 1652: case 1653: case 1654: case 1655: case 1656:

     parser.suggestFunctions({ types: [ 'STRING' ] });
     parser.suggestColumns({ types: [ 'STRING' ] });
     this.$ = { types: ['BOOLEAN'] }
   
break;
case 1657: case 1659:
this.$ = parser.findCaseType($$[$0-1]);
break;
case 1658: case 1661:

     $$[$0-3].caseTypes.push($$[$0-1]);
     this.$ = parser.findCaseType($$[$0-3]);
   
break;
case 1660:

     parser.suggestValueExpressionKeywords($$[$0-1], ['END']);
     $$[$0-3].caseTypes.push($$[$0-1]);
     this.$ = parser.findCaseType($$[$0-3]);
   
break;
case 1662:
this.$ = parser.findCaseType($$[$0-2]);
break;
case 1663:

     if ($$[$0].toLowerCase() !== 'end') {
       parser.suggestValueExpressionKeywords($$[$0-3], [{ value: 'END', weight: 3 }, { value: 'ELSE', weight: 2 }, { value: 'WHEN', weight: 1 }]);
     } else {
       parser.suggestValueExpressionKeywords($$[$0-3], [{ value: 'ELSE', weight: 2 }, { value: 'WHEN', weight: 1 }]);
     }
     this.$ = parser.findCaseType($$[$0-3]);
   
break;
case 1664:

     if ($$[$0].toLowerCase() !== 'end') {
       parser.suggestValueExpressionKeywords($$[$0-2], [{ value: 'END', weight: 3 }, { value: 'ELSE', weight: 2 }, { value: 'WHEN', weight: 1 }]);
     } else {
       parser.suggestValueExpressionKeywords($$[$0-2], [{ value: 'ELSE', weight: 2 }, { value: 'WHEN', weight: 1 }]);
     }
     this.$ = parser.findCaseType($$[$0-2]);
   
break;
case 1665:

     $$[$0-3].caseTypes.push($$[$0-1]);
     this.$ = parser.findCaseType($$[$0-3]);
     this.$.suggestFilters = $$[$0-1].suggestFilters
   
break;
case 1666:

     parser.valueExpressionSuggest();
     this.$ = parser.findCaseType($$[$0-3]);
   
break;
case 1667:

     parser.valueExpressionSuggest();
     this.$ = { types: [ 'T' ], typeSet: true };
   
break;
case 1668:

     parser.valueExpressionSuggest();
     parser.suggestKeywords(['WHEN']);
     this.$ = $$[$0-1];
   
break;
case 1669:

     parser.valueExpressionSuggest();
     parser.suggestKeywords(['WHEN']);
     this.$ = { types: [ 'T' ] };
   
break;
case 1672:
this.$ = { caseTypes: [ $$[$0] ], lastType: $$[$0] };
break;
case 1673:

     $$[$0-1].caseTypes.push($$[$0]);
     this.$ = { caseTypes: $$[$0-1].caseTypes, lastType: $$[$0] };
   
break;
case 1677:

     parser.suggestValueExpressionKeywords($$[$0-2], ['WHEN']);
   
break;
case 1680:
this.$ = { caseTypes: [{ types: ['T'] }], suggestFilters: $$[$0].suggestFilters };
break;
case 1681:
this.$ = { caseTypes: [{ types: ['T'] }], suggestFilters: $$[$0-1].suggestFilters };
break;
case 1682:
this.$ = { caseTypes: [$$[$0]], suggestFilters: $$[$0-2].suggestFilters };
break;
case 1683: case 1684:
this.$ = { caseTypes: [$$[$0]], suggestFilters: $$[$0].suggestFilters };
break;
case 1685:

     parser.suggestKeywords(['WHEN']);
     this.$ = { caseTypes: [{ types: ['T'] }] };
   
break;
case 1686:

     parser.suggestKeywords(['WHEN']);
     this.$ = { caseTypes: [$$[$0]] };
   
break;
case 1687:

     parser.valueExpressionSuggest();
     parser.suggestKeywords(['WHEN']);
     this.$ = { caseTypes: [{ types: ['T'] }] };
   
break;
case 1688:

      parser.valueExpressionSuggest();
      parser.suggestKeywords(['WHEN']);
      this.$ = { caseTypes: [{ types: ['T'] }] };
    
break;
case 1689: case 1691:

     parser.valueExpressionSuggest();
     this.$ = { caseTypes: [{ types: ['T'] }], suggestFilters: true };
   
break;
case 1690:

     parser.valueExpressionSuggest();
     parser.suggestKeywords(['THEN']);
     this.$ = { caseTypes: [{ types: ['T'] }], suggestFilters: true };
   
break;
case 1692:

     parser.valueExpressionSuggest();
     this.$ = { caseTypes: [$$[$0]], suggestFilters: true };
   
break;
case 1693:

     parser.suggestValueExpressionKeywords($$[$0-1], ['THEN']);
     this.$ = { caseTypes: [{ types: ['T'] }] };
   
break;
case 1694:

     parser.suggestValueExpressionKeywords($$[$0-2], ['THEN']);
     this.$ = { caseTypes: [{ types: ['T'] }] };
   
break;
case 1695: case 1696: case 1697: case 1698:

     parser.valueExpressionSuggest();
     this.$ = { caseTypes: [{ types: ['T'] }] };
   
break;
case 1707: case 1708:

     this.$ = { cursorAtStart : false, suggestFunctions: true, suggestColumns: true, suggestAggregateFunctions: true };
   
break;
case 1716: case 2139:

     if (!$$[$0-1]) {
       parser.suggestKeywords(['IF NOT EXISTS']);
     }
   
break;
case 1718:

     if (!$$[$0-2]) {
       parser.suggestKeywords(['IF NOT EXISTS']);
     }
   
break;
case 1735:

     if (parser.isHive()) {
       parser.suggestKeywords(['DATABASE', 'INDEX', 'SCHEMA', 'TABLE', 'VIEW']);
     } else {
       parser.suggestKeywords(['TABLE', 'VIEW']);
     }
   
break;
case 1736: case 1738:

      parser.addDatabaseLocation(_$[$0-3], [ { name: $$[$0-3] } ]);
    
break;
case 1737:

      parser.addDatabaseLocation(_$[$0-2], [ { name: $$[$0-2] } ]);
    
break;
case 1739:

     if (parser.isHive()) {
       parser.suggestDatabases();
     }
   
break;
case 1740:

     parser.addDatabaseLocation(_$[$0-1], [ { name: $$[$0-1] } ]);
     if (parser.isHive()) {
       parser.suggestKeywords(['SET DBPROPERTIES', 'SET LOCATION', 'SET OWNER']);
     }
   
break;
case 1741:

      parser.addDatabaseLocation(_$[$0-2], [ { name: $$[$0-2] } ]);
      if (parser.isHive()) {
        parser.suggestKeywords(['DBPROPERTIES', 'LOCATION', 'OWNER']);
      }
    
break;
case 1742: case 2036:

     parser.addDatabaseLocation(_$[$0-2], [ { name: $$[$0-2] } ]);
   
break;
case 1743:

     parser.addDatabaseLocation(_$[$0-3], [ { name: $$[$0-3] } ]);
     parser.suggestKeywords(['GROUP', 'ROLE', 'USER']);
   
break;
case 1744:

     parser.addDatabaseLocation(_$[$0-3], [ { name: $$[$0-3] } ]);
   
break;
case 1746: case 1829: case 2378: case 2753: case 3078: case 3288: case 3304: case 3306:

     parser.suggestKeywords(['ON']);
   
break;
case 1750:

     parser.addTablePrimary($$[$0-2]);
     if (!$$[$0-1]) {
       parser.suggestKeywords(['PARTITION', 'REBUILD']);
     } else {
       parser.suggestKeywords(['REBUILD']);
     }
   
break;
case 1771:

     if (!$$[$0-1] && parser.isImpala()) {
       parser.suggestKeywords([{ value: 'IF NOT EXISTS', weight: 4 }, { value: 'COLUMNS', weight: 3 }, { value: 'PARTITION', weight: 2 }, { value: 'RANGE PARTITION', weight: 1 }]);
     } else if (!$$[$0-1] && parser.isHive()) {
       parser.suggestKeywords([{ value: 'IF NOT EXISTS', weight: 3 }, { value: 'COLUMNS', weight: 2 }, { value: 'CONSTRAINT', weight: 1 }, {  value: 'PARTITION', weight: 1 }]);
     } else if (parser.isImpala()) {
       parser.suggestKeywords([{ value: 'PARTITION', weight: 2 }, { value: 'RANGE PARTITION', weight: 1 }]);
     } else if (parser.isHive()) {
       parser.suggestKeywords(['PARTITION']);
     }
   
break;
case 1772: case 1793: case 2063:

     parser.suggestKeywords(['COLUMNS']);
   
break;
case 1777:

     if (parser.isHive()) {
       if (!$$[$0-3] && !$$[$0-2] && !$$[$0-1]) {
         parser.suggestKeywords(['LOCATION', 'PARTITION']);
       } else if ($$[$0-2] && $$[$0-2].suggestKeywords) {
         var keywords = parser.createWeightedKeywords($$[$0-2].suggestKeywords, 2);
         keywords.push({ value: 'PARTITION', weight: 1 });
         parser.suggestKeywords(keywords);
       } else {
         parser.suggestKeywords(['PARTITION']);
       }
     } else if (parser.isImpala()) {
       if (!$$[$0-3] && !$$[$0-2] && !$$[$0-1]) {
         parser.suggestKeywords(['LOCATION', 'CACHED IN', 'UNCACHED']);
       } else if (!$$[$0-1]) {
         parser.suggestKeywords(['CACHED IN', 'UNCACHED']);
       } else if ($$[$0-1] && $$[$0-1].suggestKeywords) {
         parser.suggestKeywords($$[$0-1].suggestKeywords);
       }
     }
   
break;
case 1779: case 1812: case 1820: case 1832: case 1910: case 1936: case 3360:

     parser.suggestKeywords(['PARTITION']);
   
break;
case 1780: case 1937:

     parser.suggestKeywords(['VALUE']);
   
break;
case 1784:

     parser.suggestKeywords(['FOREIGN KEY', 'PRIMARY KEY']);
   
break;
case 1791:

     if (parser.isHive()) {
       parser.suggestKeywords(['ADD COLUMNS', 'ADD IF NOT EXISTS', 'ADD PARTITION', 'ARCHIVE PARTITION', 'CHANGE',
         'CLUSTERED BY', 'CONCATENATE', 'COMPACT', 'DISABLE NO_DROP', 'DISABLE OFFLINE', 'DROP', 'ENABLE NO_DROP',
         'ENABLE OFFLINE', 'EXCHANGE PARTITION', 'NOT SKEWED', 'NOT STORED AS DIRECTORIES', 'PARTITION',
         'RECOVER PARTITIONS', 'RENAME TO', 'REPLACE COLUMNS', 'SET FILEFORMAT', 'SET LOCATION', 'SET OWNER', 'SET SERDE',
         'SET SERDEPROPERTIES', 'SET SKEWED LOCATION', 'SET TBLPROPERTIES', 'SKEWED BY', 'TOUCH', 'UNARCHIVE PARTITION']);
     } else if (parser.isImpala()) {
       parser.suggestKeywords(['ADD COLUMNS', 'ADD PARTITION', 'ADD RANGE PARTITION', 'ALTER', 'ALTER COLUMN', 'CHANGE',
         'DROP COLUMN', 'DROP PARTITION', 'DROP RANGE PARTITION', 'PARTITION', 'RECOVER PARTITIONS', 'RENAME TO',
         'REPLACE COLUMNS', 'SET CACHED IN', 'SET COLUMN STATS', 'SET FILEFORMAT', 'SET LOCATION', 'SET ROW FORMAT',
         'SET SERDEPROPERTIES', 'SET TBLPROPERTIES', 'SET UNCACHED']);
     }
   
break;
case 1792:

     if (parser.isHive()) {
       parser.suggestKeywords(['ADD COLUMNS', 'CHANGE', 'COMPACT', 'CONCATENATE', 'DISABLE NO_DROP', 'DISABLE OFFLINE',
         'ENABLE NO_DROP', 'ENABLE OFFLINE', 'RENAME TO PARTITION', 'REPLACE COLUMNS', 'SET FILEFORMAT', 'SET LOCATION',
         'SET SERDE', 'SET SERDEPROPERTIES']);
     } else if (parser.isImpala()) {
       parser.suggestKeywords(['SET CACHED IN', 'SET FILEFORMAT', 'SET LOCATION', 'SET ROW FORMAT',
       'SET SERDEPROPERTIES', 'SET TBLPROPERTIES', 'SET UNCACHED']);
     }
   
break;
case 1794:

     if (parser.isHive()) {
       parser.suggestKeywords(['FILEFORMAT', 'LOCATION', 'SERDE', 'SERDEPROPERTIES']);
     } else if (parser.isImpala()) {
       parser.suggestKeywords(['CACHED IN', 'FILEFORMAT', 'LOCATION', 'ROW FORMAT', 'SERDEPROPERTIES','TBLPROPERTIES', 'UNCACHED']);
     }
   
break;
case 1795:

     if (parser.isHive()) {
       parser.suggestKeywords(['FILEFORMAT', 'LOCATION', 'OWNER', 'SERDE', 'SERDEPROPERTIES', 'SKEWED LOCATION', 'TBLPROPERTIES']);
     } else if (parser.isImpala()) {
       parser.suggestKeywords(['CACHED IN', 'COLUMN STATS', 'FILEFORMAT', 'LOCATION', 'ROW FORMAT', 'SERDEPROPERTIES', 'TBLPROPERTIES', 'UNCACHED']);
     }
   
break;
case 1797: case 2024: case 2811: case 2827:

     parser.suggestKeywords(['TO']);
   
break;
case 1799: case 1821: case 2311:

     parser.suggestKeywords(['PARTITIONS']);
   
break;
case 1816:

     if (parser.isHive()) {
       parser.suggestKeywords(['SKEWED', 'STORED AS DIRECTORIES']);
     }
   
break;
case 1817: case 2013:

     parser.suggestKeywords(['AS DIRECTORIES']);
   
break;
case 1818: case 2014:

     parser.suggestKeywords(['DIRECTORIES']);
   
break;
case 1819:

     parser.suggestKeywords(['TO PARTITION']);
   
break;
case 1822: case 2491: case 2510:

     parser.suggestKeywords(['LOCATION']);
   
break;
case 1825: case 2807: case 2812: case 2816: case 2883: case 2884: case 2885: case 2918: case 2926: case 2929: case 2932: case 2937: case 2940:

     parser.suggestKeywords(['GROUP', 'ROLE', 'USER']);
   
break;
case 1830:

     if (!$$[$0-1]) {
       parser.suggestKeywords(['STORED AS DIRECTORIES']);
     }
   
break;
case 1834: case 1841: case 1875: case 1878: case 1880:

     parser.addColumnLocation($$[$0-3].location, [ $$[$0-3].identifier ]);
   
break;
case 1835:

     parser.addColumnLocation($$[$0-2].location, [ $$[$0-2].identifier ]);
   
break;
case 1836: case 1844: case 1845:

     parser.addColumnLocation($$[$0-1].location, [ $$[$0-1].identifier ]);
   
break;
case 1837:

     if (parser.isImpala()) {
       if (!$$[$0-1]) {
         parser.suggestKeywords(['COLUMN']);
       }
       parser.suggestColumns();
     }
   
break;
case 1838:

     if (parser.isImpala()) {
       parser.suggestKeywords(['DROP DEFAULT', 'SET BLOCK_SIZE', 'SET COMMENT', 'SET COMPRESSION', 'SET DEFAULT',
         'SET ENCODING']);
        parser.addColumnLocation($$[$0-1].location, [ $$[$0-1].identifier ]);
     }
   
break;
case 1839:

     if (parser.isImpala()) {
       parser.suggestKeywords(['DEFAULT']);
       parser.addColumnLocation($$[$0-2].location, [ $$[$0-2].identifier ]);
     }
   
break;
case 1840:

     if (parser.isImpala()) {
       parser.suggestKeywords(['BLOCK_SIZE', 'COMMENT', 'COMPRESSION', 'DEFAULT', 'ENCODING']);
       parser.addColumnLocation($$[$0-2].location, [ $$[$0-2].identifier ]);
     }
   
break;
case 1842: case 2093: case 2735: case 3237: case 3361:

     parser.suggestKeywords(['STATS']);
   
break;
case 1862:

     parser.suggestIdentifiers(['\'avgSize\'', '\'maxSize\'', '\'numDVs\'', '\'numNulls\'']);
   
break;
case 1877:

     if (parser.isHive() && !$$[$0-1]) {
       parser.suggestKeywords(['COLUMN']);
     }
     parser.suggestColumns();
   
break;
case 1879:

     if (parser.isHive() && !$$[$0-2] && !$$[$0-1]) {
       if ($$[$0-3].suggestKeywords) {
         var keywords = parser.createWeightedKeywords($$[$0-3].suggestKeywords, 3);
         keywords = keywords.concat([{ value: 'AFTER', weight: 2 }, { value: 'FIRST', weight: 2 }, { value: 'CASCADE', weight: 1 }, { value: 'RESTRICT', weight: 1 }]);
         parser.suggestKeywords(keywords);
       } else {
         parser.suggestKeywords([{ value: 'AFTER', weight: 2 }, { value: 'FIRST', weight: 2 }, { value: 'CASCADE', weight: 1 }, { value: 'RESTRICT', weight: 1 }]);
       }
     } else if (parser.isHive() && $$[$0-2] && !$$[$0-1]) {
       parser.suggestKeywords(['CASCADE', 'RESTRICT']);
     }
     parser.addColumnLocation($$[$0-4].location, [ $$[$0-4].identifier ]);
   
break;
case 1881:

     if (!$$[$0-2] && !$$[$0-1]) {
       parser.suggestKeywords(['AND WAIT', 'WITH OVERWRITE TBLPROPERTIES']);
     } else if (!$$[$0-1]) {
       parser.suggestKeywords(['WITH OVERWRITE TBLPROPERTIES']);
     }
   
break;
case 1884:

     parser.suggestKeywords(['NO_DROP', 'OFFLINE']);
   
break;
case 1886: case 2398:

     parser.suggestFileFormats();
   
break;
case 1889:

     if (!$$[$0-1]) {
       parser.suggestKeywords(['WITH REPLICATION =']);
     }
   
break;
case 1891:

     if (parser.isImpala()) {
       parser.suggestKeywords(['FORMAT']);
     }
   
break;
case 1892: case 3024:

     parser.suggestKeywords(['DELIMITED']);
   
break;
case 1895:

     if (!$$[$0-1]) {
       parser.suggestKeywords(['WITH SERDEPROPERTIES']);
     }
   
break;
case 1899:

     parser.suggestKeywords(['WAIT']);
   
break;
case 1902:

     parser.suggestKeywords(['OVERWRITE TBLPROPERTIES']);
   
break;
case 1903:

     parser.suggestKeywords(['TBLPROPERTIES']);
   
break;
case 1906:

     if (parser.isHive() && !$$[$0-1]) {
       parser.suggestKeywords(['CASCADE', 'RESTRICT']);
     }
   
break;
case 1911:

     parser.suggestKeywords(['WITH TABLE']);
   
break;
case 1912: case 2031: case 2045: case 2603: case 2627: case 2767: case 3158: case 3167: case 3292:

     parser.suggestKeywords(['TABLE']);
   
break;
case 1930:

     parser.addColumnLocation($$[$0].location, [ $$[$0].identifier ]);
   
break;
case 1931:

     if (parser.isHive() && !$$[$0-1]) {
       parser.suggestKeywords([{ value: 'CONSTRAINT', weight: 1}, { value: 'PARTITION', weight: 1}, { value: 'IF EXISTS', weight: 2 }]);
     } else if (parser.isHive()) {
        parser.suggestKeywords(['PARTITION']);
     } else if (parser.isImpala() && !$$[$0-1]) {
       parser.suggestKeywords([{ value: 'COLUMN', weight: 1 }, { value: 'PARTITION', weight: 1 }, { value: 'RANGE PARTITION', weight: 1 }, { value: 'IF EXISTS', weight: 2 }]);
       parser.suggestColumns();
     } else if (parser.isImpala()) {
       parser.suggestKeywords(['PARTITION', 'RANGE PARTITION']);
     }
   
break;
case 1933:

     if (parser.isHive() && !$$[$0-1]) {
       parser.suggestKeywords(['PURGE']);
     }
   
break;
case 1944: case 2047: case 2744:

     if (parser.yy.result.suggestTables) {
       parser.yy.result.suggestTables.onlyTables = true;
     }
   
break;
case 1945: case 2032: case 2046:

     parser.suggestTables({ onlyTables: true });
     parser.suggestDatabases({ appendDot: true });
   
break;
case 1970:

     if (!$$[$0-1]) {
       parser.suggestKeywords(['CASCADE']);
     }
   
break;
case 1978: case 1979: case 1980:

     if (parser.isHive()) {
       parser.suggestKeywords(['PARTITION']);
     }
   
break;
case 1996:

     if (!$$[$0]) {
       this.$ = { suggestKeywords: ['LOCATION'] };
     }
   
break;
case 2020:

     if (parser.isHive()) {
       parser.suggestKeywords(['AS', 'SET TBLPROPERTIES']);
     } else if (parser.isImpala()) {
       parser.suggestKeywords(['AS', 'RENAME TO']);
     } else {
       parser.suggestKeywords(['AS']);
     }
   
break;
case 2021:

     if (parser.isHive()) {
       parser.suggestKeywords(['TBLPROPERTIES']);
     }
   
break;
case 2027: case 2033: case 2765:

     if (parser.yy.result.suggestTables) {
       parser.yy.result.suggestTables.onlyViews = true;
     }
   
break;
case 2028:

     parser.suggestTables({ onlyViews: true });
     parser.suggestDatabases({ appendDot: true });
   
break;
case 2030:

     parser.suggestKeywords(['REPAIR TABLE']);
   
break;
case 2035: case 2502: case 2713:

     parser.suggestKeywords(['FUNCTION']);
   
break;
case 2037:

     parser.suggestKeywords(['ON DATABASE']);
   
break;
case 2038:

     parser.suggestKeywords(['DATABASE']);
   
break;
case 2040:

     parser.addDatabaseLocation(_$[$0-1], [ { name: $$[$0-1] } ]);
     parser.suggestKeywords(['IS']);
   
break;
case 2041:

     parser.addDatabaseLocation(_$[$0-2], [ { name: $$[$0-2] } ]);
     parser.suggestKeywords(['NULL']);
   
break;
case 2044:

     parser.addTablePrimary($$[$0-6]);
   
break;
case 2049:

     parser.addTablePrimary($$[$0-2]);
     if (!$$[$0-1]) {
       parser.suggestKeywords([{ value: 'PARTITION', weight: 2 }, { value: 'COMPUTE STATISTICS', weight: 1 }]);
     } else {
       parser.suggestKeywords(['COMPUTE STATISTICS']);
     }
   
break;
case 2050:

     parser.addTablePrimary($$[$0-3]);
     parser.suggestKeywords(['STATISTICS']);
   
break;
case 2051:

     parser.addTablePrimary($$[$0-7]);
     parser.suggestKeywords(parser.getKeywordsForOptionalsLR([$$[$0-2], $$[$0-1], $$[$0]], [{ value: 'FOR COLUMNS', weight: 3 }, { value: 'CACHE METADATA', weight: 2 }, { value: 'NOSCAN', weight: 1 }]));
   
break;
case 2052:

     parser.addTablePrimary($$[$0-7]);
     parser.suggestKeywords(parser.getKeywordsForOptionalsLR([$$[$0-1], $$[$0]], [{ value: 'CACHE METADATA', weight: 2 }, { value: 'NOSCAN', weight: 1 }]));
   
break;
case 2053:

     parser.addTablePrimary($$[$0-7]);
     parser.suggestKeywords(parser.getKeywordsForOptionalsLR([$$[$0]], [{ value: 'NOSCAN', weight: 1 }]));
   
break;
case 2054:

     parser.suggestKeywords(['TABLE']);
     parser.addTablePrimary($$[$0-1]);
   
break;
case 2055:

     parser.suggestKeywords(['TABLE']);
     parser.addTablePrimary($$[$0-6]);
   
break;
case 2067: case 2079:

     parser.suggestKeywords(['METADATA']);
   
break;
case 2072:

     parser.suggestTables();
     parser.suggestDatabases({ appendDot: true });
     parser.suggestKeywords(['FUNCTIONS']);
   
break;
case 2074: case 3130: case 3270:

     parser.addTablePrimary($$[$0-2]);
     if (!$$[$0-1]) {
       parser.suggestKeywords(['PARTITION']);
     }
   
break;
case 2082:

     parser.addTablePrimary($$[$0]);
     parser.suggestKeywords(['METADATA']);
   
break;
case 2085:

     parser.suggestKeywords(['STATS', 'INCREMENTAL STATS']);
   
break;
case 2088:

     parser.addTablePrimary($$[$0-1]);
     parser.suggestKeywords(['STATS', 'INCREMENTAL STATS']);
   
break;
case 2089:

     parser.addTablePrimary($$[$0-3]);
     if (!$$[$0-1]) {
       parser.suggestKeywords(['TABLESAMPLE']);
     } else if ($$[$0-1].suggestKeywords) {
       parser.suggestKeywords($$[$0-1].suggestKeywords);
     }
   
break;
case 2092: case 2734:

     parser.addTablePrimary($$[$0-1]);
     parser.suggestKeywords(['INCREMENTAL']);
   
break;
case 2094:

     parser.addTablePrimary($$[$0-1]);
     parser.suggestKeywords(['STATS']);
   
break;
case 2097:

     parser.addTablePrimary($$[$0-2]);
     if (!$$[$0]) {
       parser.suggestKeywords(['PARTITION']);
     }
   
break;
case 2112:

     if ($$[$0-1]) {
       parser.suggestKeywords(['TABLE']);
     } else if (parser.isHive()) {
       if ($$[$0-2]) {
         parser.suggestKeywords(['EXTERNAL TABLE', 'FUNCTION', 'MACRO', 'TABLE']);
       } else {
         parser.suggestKeywords(['DATABASE', 'EXTERNAL TABLE', 'FUNCTION', 'INDEX', 'ROLE', 'SCHEMA', 'TABLE', 'TEMPORARY EXTERNAL TABLE', 'TEMPORARY FUNCTION', 'TEMPORARY MACRO', 'TEMPORARY TABLE', 'VIEW']);
       }
     } else if (parser.isImpala()) {
       parser.suggestKeywords(['AGGREGATE FUNCTION', 'DATABASE', 'EXTERNAL TABLE', 'FUNCTION', 'ROLE', 'SCHEMA', 'TABLE', 'VIEW']);
     } else {
       parser.suggestKeywords(['DATABASE', 'ROLE', 'SCHEMA', 'TABLE', 'VIEW']);
     }
   
break;
case 2115:

     var keywords = [];
     if (!$$[$0] && parser.isHive()) {
       keywords.push('WITH DBPROPERTIES');
     }
     if (!$$[$0-1] && !$$[$0]) {
       keywords.push('LOCATION');
     }
     if (!$$[$0-2] && !$$[$0-1] && !$$[$0]) {
       keywords.push('COMMENT');
     }
     if (keywords.length > 0) {
       parser.suggestKeywords(keywords);
     }
   
break;
case 2130:

     parser.suggestKeywords(['DBPROPERTIES']);
   
break;
case 2152:

     var keywords = [];
     if (!$$[$0-10] && !$$[$0-9] && !$$[$0-8] && !$$[$0-7] && !$$[$0-6] && !$$[$0-5] && !$$[$0-4] && !$$[$0-3] && !$$[$0-2] && !$$[$0-1] && !$$[$0]) {
       keywords.push({ value: 'LIKE', weight: 1 });
       if (parser.isImpala()) {
         keywords.push({ value: 'LIKE PARQUET', weight: 1 });
       }
     } else {
       if (!$$[$0-9] && !$$[$0-8] && !$$[$0-7] && !$$[$0-6] && !$$[$0-5] && !$$[$0-4] && !$$[$0-3] && !$$[$0-2] && !$$[$0-1] && !$$[$0]) {
         keywords.push({ value: 'COMMENT', weight: 11 });
       }
       if (!$$[$0-8] && !$$[$0-7] && !$$[$0-6] && !$$[$0-5] && !$$[$0-4] && !$$[$0-3] && !$$[$0-2] && !$$[$0-1] && !$$[$0]) {
         keywords.push({ value: 'PARTITIONED BY', weight: 10 });
         if (parser.isImpala()) {
           keywords.push({ value: 'PARTITION BY', weight: 10 });
         }
       }
       if (parser.isImpala() && !$$[$0-7] && !$$[$0-6] && !$$[$0-5] && !$$[$0-4] && !$$[$0-3] && !$$[$0-2] && !$$[$0-1] && !$$[$0]) {
         keywords.push({ value: 'SORT BY', weight: 9 });
       }
       if (parser.isHive() && !$$[$0-6] && !$$[$0-5] && !$$[$0-4] && !$$[$0-3] && !$$[$0-2] && !$$[$0-1] && !$$[$0]) {
         keywords.push({ value: 'CLUSTERED BY', weight: 8 });
       }
       if (parser.isHive() && !$$[$0-5] && !$$[$0-4] && !$$[$0-3] && !$$[$0-2] && !$$[$0-1] && !$$[$0]) {
         keywords.push({ value: 'SKEWED BY', weight: 7 });
       } else if (parser.isHive() && $$[$0-5] && $$[$0-5].suggestKeywords && !$$[$0-4] && !$$[$0-3] && !$$[$0-2] && !$$[$0-1] && !$$[$0-1]) {
         keywords = keywords.concat(parser.createWeightedKeywords($$[$0-5].suggestKeywords, 7)); // Get the last optional from SKEWED BY
       }
       if (!$$[$0-4] && !$$[$0-3] && !$$[$0-2] && !$$[$0-1] && !$$[$0]) {
         keywords.push({ value: 'ROW FORMAT', weight: 6 });
         keywords.push({ value: 'STORED AS', weight: 6 });
         if (parser.isHive()) {
           keywords.push({ value: 'STORED BY', weight: 6 });
         }
       } else if ($$[$0-4] && $$[$0-4].suggestKeywords && !$$[$0-3] && !$$[$0-2] && !$$[$0-1] && !$$[$0]) {
         keywords = keywords.concat(parser.createWeightedKeywords($$[$0-4].suggestKeywords, 6));
       }
       if ((($$[$0-4] && $$[$0-4].storedBy) || parser.isImpala()) && !$$[$0-3] && !$$[$0-2] && !$$[$0-1] && !$$[$0]) {
         keywords.push({ value: 'WITH SERDEPROPERTIES', weight: 5 });
       }
       if (!$$[$0-2] && !$$[$0-1] && !$$[$0]) {
         keywords.push({ value: 'LOCATION', weight: 4 });
       }
       if (!$$[$0-1] && !$$[$0]) {
         keywords.push({ value: 'TBLPROPERTIES', weight: 3 });
       }
       if (parser.isImpala() && !$$[$0]) {
         keywords.push({ value: 'CACHED IN', weight: 2 }, { value: 'UNCACHED', weight: 2 });
       }
       if (parser.isImpala() && $$[$0] && $$[$0].suggestKeywords) {
         keywords = keywords.concat(parser.createWeightedKeywords($$[$0].suggestKeywords, 2));
       }
       keywords.push({ value: 'AS', weight: 1 });
     }

     if (keywords.length > 0) {
       parser.suggestKeywords(keywords);
     }
   
break;
case 2162:

     parser.suggestTables();
     parser.suggestDatabases({ appendDot: true });
     if (parser.isImpala()) {
       parser.suggestKeywords(['PARQUET']);
     }
   
break;
case 2168:

     if (parser.isImpala()) {
       parser.suggestKeywords(['PRIMARY KEY']);
     } else if (parser.isHive()) {
       parser.suggestKeywords([{ value: 'PRIMARY KEY', weight: 2 }, { value: 'CONSTRAINT', weight: 1 }]);
     }
   
break;
case 2175: case 2177: case 2370:

     parser.checkForKeywords($$[$0-1]);
   
break;
case 2176: case 2178:

     parser.checkForKeywords($$[$0-3]);
   
break;
case 2179:

     this.$ = $$[$0-2];
     var keywords = [];
     if (parser.isImpala()) {
       if (!$$[$0]['primary']) {
         keywords.push('PRIMARY KEY');
       }
       if (!$$[$0]['encoding']) {
         keywords.push('ENCODING');
       }
       if (!$$[$0]['compression']) {
         keywords.push('COMPRESSION');
       }
       if (!$$[$0]['default']) {
         keywords.push('DEFAULT');
       }
       if (!$$[$0]['block_size']) {
         keywords.push('BLOCK_SIZE');
       }
       if (!$$[$0]['null']) {
         keywords.push('NOT NULL');
         keywords.push('NULL');
       }
     }
     if (!$$[$0]['comment']) {
       keywords.push('COMMENT');
       if (parser.isHive() && $$[$0-1].toLowerCase() === 'double') {
         keywords.push({ value: 'PRECISION', weight: 2 });
       }
     }
     if (keywords.length > 0) {
       this.$.suggestKeywords = keywords;
     }
   
break;
case 2180: case 2216: case 2222: case 2223: case 2236: case 2239: case 2251: case 2253: case 2653:

     parser.suggestKeywords(parser.getColumnDataTypeKeywords());
   
break;
case 2185:

     this.$ = {};
     this.$[$$[$0]] = true;
   
break;
case 2186:

     $$[$0-1][$$[$0]] = true;
   
break;
case 2191:
this.$ = 'primary';
break;
case 2192:
this.$ = 'encoding';
break;
case 2193:
this.$ = 'compression';
break;
case 2194:
this.$ = 'default';
break;
case 2195:
this.$ = 'block_size';
break;
case 2196: case 2197:
this.$ = 'null';
break;
case 2198:
this.$ = 'comment';
break;
case 2200:

     if (parser.isImpala()) {
       parser.suggestKeywords(['NULL']);
     }
   
break;
case 2221: case 2537: case 2548: case 2571:

     parser.suggestKeywords(parser.getTypeKeywords());
   
break;
case 2235: case 2238:

     parser.suggestKeywords(['COMMENT']);
   
break;
case 2263:

     parser.suggestKeywords(['CONSTRAINT']);
   
break;
case 2264: case 2267:

     parser.suggestKeywords(['FOREIGN KEY']);
   
break;
case 2269:

     parser.suggestKeywords(['PRIMARY KEY']);
   
break;
case 2273:

     parser.suggestKeywords(['DISABLE NOVALIDATE']);
   
break;
case 2274:

     parser.suggestKeywords(['NOVALIDATE']);
   
break;
case 2276: case 3165: case 3172: case 3179:

     parser.addTablePrimary($$[$0-4]);
   
break;
case 2277: case 2294: case 2296:

     parser.suggestKeywords(['KEY']);
   
break;
case 2279:

     parser.suggestKeywords(['REFERENCES']);
   
break;
case 2283:

     parser.addTablePrimary($$[$0-2]);
     parser.suggestKeywords(['DISABLE NOVALIDATE']);
   
break;
case 2284:

     parser.addTablePrimary($$[$0-3]);
     parser.suggestKeywords(['NOVALIDATE']);
   
break;
case 2285:

     parser.addTablePrimary($$[$0-5]);
     if (!$$[$0-1]) {
       parser.suggestKeywords(['NORELY', 'RELY']);
     }
   
break;
case 2307:

     parser.suggestKeywords(['HASH', 'RANGE']);
   
break;
case 2319: case 2324: case 2325:

     if (parser.isImpala()) {
       parser.suggestKeywords(['PARTITION']);
     }
   
break;
case 2332:

     if (parser.isImpala()) {
       parser.suggestKeywords(['VALUE', 'VALUES']);
     }
   
break;
case 2334: case 2641: case 3074:

     parser.suggestFunctions();
   
break;
case 2335:

     if ($$[$0].endsWithLessThanOrEqual && parser.isImpala()) {
      parser.suggestKeywords(['VALUES']);
     }
   
break;
case 2336: case 2339: case 2342:

     if (parser.isImpala()) {
       parser.suggestKeywords(['<', '<=']);
     }
   
break;
case 2337:

    if (parser.isImpala()) {
      parser.suggestKeywords(['VALUES']);
    }
   
break;
case 2340: case 2343:

     if (parser.isImpala()) {
      parser.suggestFunctions();
     }
   
break;
case 2353:

     if (!$$[$0-1]) {
       parser.suggestKeywords([{ value: 'INTO', weight: 1 }, { value: 'SORTED BY', weight: 2 }]);
     } else {
       parser.suggestKeywords(['INTO']);
     }
   
break;
case 2354:

     parser.suggestKeywords(['BUCKETS']);
   
break;
case 2375:
this.$ = { suggestKeywords: ['STORED AS DIRECTORIES'] };
break;
case 2385:

     this.$ = parser.mergeSuggestKeywords($$[$0-1], $$[$0])
   
break;
case 2386: case 2387:

    this.$ = { storedBy: true }
  
break;
case 2388:

     if (parser.isHive()) {
       parser.suggestKeywords(['AS', 'BY']);
     } else {
       parser.suggestKeywords(['AS']);
     }
   
break;
case 2390:

     parser.suggestKeywords(['FORMAT']);
   
break;
case 2391:

     if (parser.isHive()) {
       parser.suggestKeywords(['DELIMITED', 'SERDE']);
     } else {
       parser.suggestKeywords(['DELIMITED']);
     }
   
break;
case 2395:
this.$ = { suggestKeywords: ['STORED AS'] };
break;
case 2421:

     if (!$$[$0-4] && !$$[$0-3] && !$$[$0-2] && !$$[$0-1] && !$$[$0]) {
       this.$ = { suggestKeywords: [{ value: 'FIELDS TERMINATED BY', weight: 5 }, { value: 'COLLECTION ITEMS TERMINATED BY', weight: 4 }, { value: 'MAP KEYS TERMINATED BY', weight: 3 }, { value: 'LINES TERMINATED BY', weight: 2 }, { value: 'NULL DEFINED AS', weight: 1 }]};
     } else if ($$[$0-4] && $$[$0-4].suggestKeywords && !$$[$0-3] && !$$[$0-2] && !$$[$0-1] && !$$[$0]) {
       this.$ = { suggestKeywords: parser.createWeightedKeywords($$[$0-4].suggestKeywords, 5).concat([{ value: 'COLLECTION ITEMS TERMINATED BY', weight: 4 }, { value: 'MAP KEYS TERMINATED BY', weight: 3 }, { value: 'LINES TERMINATED BY', weight: 2 }, { value: 'NULL DEFINED AS', weight: 1 }]) };
     } else if (!$$[$0-3] && !$$[$0-2] && !$$[$0-1] && !$$[$0]) {
       this.$ = { suggestKeywords: [{ value: 'COLLECTION ITEMS TERMINATED BY', weight: 4 }, { value: 'MAP KEYS TERMINATED BY', weight: 3 }, { value: 'LINES TERMINATED BY', weight: 2 }, { value: 'NULL DEFINED AS', weight: 1 }] };
     } else if (!$$[$0-2] && !$$[$0-1] && !$$[$0]) {
       this.$ = { suggestKeywords: [{ value: 'MAP KEYS TERMINATED BY', weight: 3 }, { value: 'LINES TERMINATED BY', weight: 2 }, { value: 'NULL DEFINED AS', weight: 1 }] };
     } else if (!$$[$0-1] && !$$[$0]) {
       this.$ = { suggestKeywords: [{ value: 'LINES TERMINATED BY', weight: 2 }, { value: 'NULL DEFINED AS', weight: 1 }] };
     } else if (!$$[$0]) {
       this.$ = { suggestKeywords: [{ value: 'NULL DEFINED AS', weight: 1 }] };
     }
   
break;
case 2427:

     if (!$$[$0-1] && !$$[$0]) {
       this.$ = { suggestKeywords: [{ value: 'FIELDS TERMINATED BY', weight: 2 }, { value: 'LINES TERMINATED BY', weight: 1 }] };
     } else if ($$[$0-1] && $$[$0-1].suggestKeywords && !$$[$0]) {
       this.$ = { suggestKeywords: parser.createWeightedKeywords($$[$0-1].suggestKeywords, 2).concat(['LINES TERMINATED BY']) };
     } else if (!$$[$0]) {
       this.$ = { suggestKeywords: [{ value: 'LINES TERMINATED BY', weight: 1 }] };
     }
   
break;
case 2431:
this.$ = { suggestKeywords: ['ESCAPED BY'] };
break;
case 2433: case 2439: case 2444: case 2448:

     parser.suggestKeywords(['TERMINATED BY']);
   
break;
case 2438:

     parser.suggestKeywords(['ITEMS TERMINATED BY']);
   
break;
case 2443:

     parser.suggestKeywords(['KEYS TERMINATED BY']);
   
break;
case 2452:

     parser.suggestKeywords(['DEFINED AS']);
   
break;
case 2458: case 2459:

     parser.suggestKeywords(['SERDEPROPERTIES']);
   
break;
case 2469:

     parser.commitLocations();
   
break;
case 2471: case 2488: case 2504:

     if (!$$[$0-1]) {
       parser.suggestKeywords(['IF NOT EXISTS']);
     }
     parser.suggestDatabases({ appendDot: true });
   
break;
case 2472:

     if (!$$[$0-7]) {
       parser.suggestKeywords(['IF NOT EXISTS']);
     }
   
break;
case 2475:

     var keywords = [{value: 'AS', weight: 1 }];
     if (!$$[$0-1]) {
       if (parser.isHive()) {
         keywords.push({ value: 'TBLPROPERTIES', weight: 2 });
       }
       if (!$$[$0-2]) {
         keywords.push({ value: 'COMMENT', weight: 3 });
       }
     }
     parser.suggestKeywords(keywords);
   
break;
case 2489:

     if (!$$[$0-6]) {
       parser.suggestKeywords(['IF NOT EXISTS']);
     }
   
break;
case 2490: case 2509:

     parser.suggestKeywords(['RETURNS']);
   
break;
case 2492:

     parser.suggestKeywords(['SYMBOL']);
   
break;
case 2503:

     if (!$$[$0-13]) {
       parser.suggestKeywords(['IF NOT EXISTS']);
     }
   
break;
case 2511:

     if (!$$[$0-1]) {
       parser.suggestKeywords([{value: 'INIT_FN', weight: 2 }, {value: 'UPDATE_FN', weight: 1 }]);
     } else {
       parser.suggestKeywords([{value: 'UPDATE_FN', weight: 1 }]);
     }
   
break;
case 2512:

     parser.suggestKeywords(['MERGE_FN']);
   
break;
case 2513:

     if (!$$[$0-5] && !$$[$0-4] && !$$[$0-3] && !$$[$0-2] && !$$[$0-1]) {
       parser.suggestKeywords([{value: 'PREPARE_FN', weight: 5 }, {value: 'CLOSE_FN', weight: 4 }, {value: 'SERIALIZE_FN', weight: 3 }, {value: 'FINALIZE_FN', weight: 2 }, {value: 'INTERMEDIATE', weight: 1 }]);
     } else if ($$[$0-5] && !$$[$0-4] && !$$[$0-3] && !$$[$0-2] && !$$[$0-1]) {
       parser.suggestKeywords([{value: 'CLOSE_FN', weight: 4 }, {value: 'SERIALIZE_FN', weight: 3 }, {value: 'FINALIZE_FN', weight: 2 }, {value: 'INTERMEDIATE', weight: 1 }]);
     } else if ($$[$0-4] && !$$[$0-3] && !$$[$0-2] && !$$[$0-1]) {
       parser.suggestKeywords([{value: 'SERIALIZE_FN', weight: 3 }, {value: 'FINALIZE_FN', weight: 2 }, {value: 'INTERMEDIATE', weight: 1 }]);
     } else if ($$[$0-3] && !$$[$0-2] && !$$[$0-1]) {
       parser.suggestKeywords([{value: 'FINALIZE_FN', weight: 2 }, {value: 'INTERMEDIATE', weight: 1 }]);
     } else if ($$[$0-2] && !$$[$0-1]) {
       parser.suggestKeywords([{value: 'INTERMEDIATE', weight: 1 }]);
     }
   
break;
case 2532:

     if (!$$[$0-1]) {
       parser.suggestKeywords(['USING']);
     } else {
       parser.suggestKeywords(['ARCHIVE', 'FILE', 'JAR']);
     }
   
break;
case 2538:

     parser.suggestKeywords(['...']);
   
break;
case 2573:

     parser.suggestFunctions();
     parser.suggestAggregateFunctions();
     parser.suggestAnalyticFunctions();
   
break;
case 2576:

     parser.suggestKeywords(['ARCHIVE', 'FILE', 'JAR']);
   
break;
case 2588:

     if (!$$[$0-1]) {
       parser.suggestKeywords(['COMMENT']);
     }
   
break;
case 2592: case 2594:
this.$ = $$[$0-3];
break;
case 2602:

     parser.suggestKeywords(['ON TABLE']);
   
break;
case 2608: case 2618:

     parser.suggestKeywords(['\'BITMAP\'', '\'COMPACT\'']);
   
break;
case 2616:

     if (!$$[$0-7] && !$$[$0-6] && !$$[$0-5] && !$$[$0-4] && !$$[$0-3] && !$$[$0-2] && !$$[$0-1]) {
       parser.suggestKeywords([{ value: 'WITH DEFERRED REBUILD', weight: 7 }, { value: 'IDXPROPERTIES', weight: 6 }, { value: 'IN TABLE', weight: 5 }, { value: 'ROW FORMAT', weight: 4 }, { value: 'STORED AS', weight: 4 }, { value: 'STORED BY', weight: 4 }, { value: 'LOCATION', weight: 3 }, { value: 'TBLPROPERTIES', weight: 2 }, { value: 'COMMENT', weight: 1 }]);
     } else if (!$$[$0-6] && !$$[$0-5] && !$$[$0-4] && !$$[$0-3] && !$$[$0-2] && !$$[$0-1]) {
       parser.suggestKeywords([{ value: 'IDXPROPERTIES', weight: 6 }, { value: 'IN TABLE', weight: 5 }, { value: 'ROW FORMAT', weight: 4 }, { value: 'STORED AS', weight: 4 }, { value: 'STORED BY', weight: 4 }, { value: 'LOCATION', weight: 3 }, { value: 'TBLPROPERTIES', weight: 2 }, { value: 'COMMENT', weight: 1 }]);
     } else if (!$$[$0-5] && !$$[$0-4] && !$$[$0-3] && !$$[$0-2] && !$$[$0-1]) {
       parser.suggestKeywords([{ value: 'IN TABLE', weight: 5 }, { value: 'ROW FORMAT', weight: 4 }, { value: 'STORED AS', weight: 4 }, { value: 'STORED BY', weight: 4 }, { value: 'LOCATION', weight: 3 }, { value: 'TBLPROPERTIES', weight: 2 }, { value: 'COMMENT', weight: 1 }]);
     } else if (!$$[$0-4] && !$$[$0-3] && !$$[$0-2] && !$$[$0-1]) {
       parser.suggestKeywords([{ value: 'ROW FORMAT', weight: 4 }, { value: 'STORED AS', weight: 4 }, { value: 'STORED BY', weight: 4 }, { value: 'LOCATION', weight: 3 }, { value: 'TBLPROPERTIES', weight: 2 }, { value: 'COMMENT', weight: 1 }]);
     } else if ($$[$0-4] && $$[$0-4].suggestKeywords && !$$[$0-3] && !$$[$0-2] && !$$[$0-1]) {
       parser.suggestKeywords(parser.createWeightedKeywords($$[$0-4].suggestKeywords, 4).concat([{ value: 'LOCATION', weight: 3 }, { value: 'TBLPROPERTIES', weight: 2 }, { value: 'COMMENT', weight: 1 }]));
     } else if (!$$[$0-3] && !$$[$0-2] && !$$[$0-1]) {
       parser.suggestKeywords([{ value: 'LOCATION', weight: 3 }, { value: 'TBLPROPERTIES', weight: 2 }, { value: 'COMMENT', weight: 1 }]);
     } else if (!$$[$0-2] && !$$[$0-1]) {
       parser.suggestKeywords([{ value: 'TBLPROPERTIES', weight: 2 }, { value: 'COMMENT', weight: 1 }]);
     } else if (!$$[$0-1]) {
       parser.suggestKeywords([{ value: 'COMMENT', weight: 1 }]);
     }
   
break;
case 2621:

     parser.suggestKeywords(['DEFERRED REBUILD']);
   
break;
case 2622:

     parser.suggestKeywords(['REBUILD']);
   
break;
case 2667: case 2669:

     parser.addCommonTableExpressions($$[$0-1]);
   
break;
case 2693:

     if (parser.isHive()) {
       parser.suggestKeywords(['DATABASE', 'FUNCTION', 'INDEX', 'ROLE', 'SCHEMA', 'TABLE', 'TEMPORARY FUNCTION', 'TEMPORARY MACRO', 'VIEW']);
     } else if (parser.isImpala()) {
       parser.suggestKeywords(['AGGREGATE FUNCTION', 'DATABASE', 'FUNCTION', 'INCREMENTAL STATS', 'ROLE', 'SCHEMA', 'STATS', 'TABLE', 'VIEW']);
     } else {
       parser.suggestKeywords(['ROLE', 'SCHEMA', 'TABLE', 'VIEW']);
     }
   
break;
case 2697:

     if (!$$[$0-1]) {
       parser.suggestKeywords(['IF EXISTS']);
     }
     parser.suggestDatabases();
   
break;
case 2698:

     if (parser.isHive() || parser.isImpala()) {
       parser.suggestKeywords(['CASCADE', 'RESTRICT']);
     }
   
break;
case 2700: case 2709: case 2714:

     if (!$$[$0-3]) {
       parser.suggestKeywords(['IF EXISTS']);
     }
   
break;
case 2707: case 2708:

     if (!$$[$0-1]) {
       parser.suggestKeywords(['IF EXISTS']);
     }
     parser.suggestDatabases({ appendDot: true });
   
break;
case 2711:

     parser.suggestKeywords(['AGGREGATE']);
   
break;
case 2721: case 2726: case 2758:

     if (!$$[$0-1]) {
       parser.suggestKeywords(['IF EXISTS']);
     }
   
break;
case 2722:

     if (!$$[$0-2]) {
       parser.suggestKeywords(['IF EXISTS']);
     }
   
break;
case 2733:

     parser.addTablePrimary($$[$0]);
     parser.suggestKeywords(['INCREMENTAL']);
   
break;
case 2739: case 3330:

     parser.addTablePrimary($$[$0-1]);
     parser.suggestKeywords(['PARTITION']);
   
break;
case 2743:

     if (!$$[$0-1]) {
       parser.suggestKeywords(['IF EXISTS']);
     }
     parser.suggestTables({ onlyTables: true });
     parser.suggestDatabases({
       appendDot: true
     });
   
break;
case 2746:

     parser.addTablePrimary($$[$0-2]);
     if (!$$[$0-1]) {
       parser.suggestKeywords(['PURGE']);
     }
   
break;
case 2751:

     parser.suggestKeywords(['IF EXISTS']);
   
break;
case 2757:

     parser.suggestKeywords(['FUNCTION', 'MACRO']);
   
break;
case 2761:

     if (!$$[$0-1]) {
       parser.suggestKeywords(['IF EXISTS']);
     }
     parser.suggestTables({ onlyViews: true });
     parser.suggestDatabases({ appendDot: true });
   
break;
case 2762:

     parser.addTablePrimary($$[$0]);
     if (!$$[$0-2]) {
       parser.suggestKeywords(['IF EXISTS']);
     }
   
break;
case 2768:

     parser.suggestTables();
     parser.suggestDatabases({ appendDot: true });
     if (parser.isImpala() && !$$[$0-2]) {
       parser.suggestKeywords(['IF EXISTS']);
     }
   
break;
case 2771:

     parser.addTablePrimary($$[$0-2]);
     if (parser.isHive() && !$$[$0-1]) {
       parser.suggestKeywords(['PARTITION']);
     }
   
break;
case 2773:

     parser.addTablePrimary($$[$0-2]);
     if (parser.isImpala() && !$$[$0-3]) {
       parser.suggestKeywords(['IF EXISTS']);
     }
   
break;
case 2776: case 2931: case 2936: case 2939: case 2943: case 2951:

     parser.suggestKeywords(['FROM']);
   
break;
case 2778:

     parser.addTablePrimary($$[$0-2]);
     if (!$$[$0]) {
       parser.suggestKeywords(['WHERE']);
     }
   
break;
case 2782:

     parser.suggestKeywords(['FROM']);
     if (parser.isImpala() && !$$[$0-1]) {
       parser.suggestTables();
       parser.suggestDatabases({ appendDot: true });
     }
   
break;
case 2785:

     var keywords = [{ value: 'FULL JOIN', weight: 1 }, { value: 'FULL OUTER JOIN', weight: 1 }, { value: 'JOIN', weight: 1 }, { value: 'LEFT JOIN', weight: 1 }, { value: 'LEFT OUTER JOIN', weight: 1 }, { value: 'RIGHT JOIN', weight: 1 }, { value: 'RIGHT OUTER JOIN', weight: 1 }, { value: 'INNER JOIN', weight: 1 },  { value: 'LEFT ANTI JOIN', weight: 1 }, { value: 'LEFT SEMI JOIN', weight: 1 }, { value: 'RIGHT ANTI JOIN', weight: 1 }, { value: 'RIGHT SEMI JOIN', weight: 1 }];
     if (!$$[$0]) {
       keywords.push({ value: 'WHERE', weight: 3 });
     }
     if ($$[$0-2].suggestJoinConditions) {
       parser.suggestJoinConditions($$[$0-2].suggestJoinConditions);
     }
     if ($$[$0-2].suggestJoins) {
       parser.suggestJoins($$[$0-2].suggestJoins);
     }
     if ($$[$0-2].suggestKeywords) {
       keywords = keywords.concat(parser.createWeightedKeywords($$[$0-2].suggestKeywords, 2));
     }
     if (keywords.length > 0) {
       parser.suggestKeywords(keywords);
     }
   
break;
case 2794:

     parser.suggestKeywords(['TRANSACTIONS']);
   
break;
case 2803:

     parser.suggestKeywords(['ALL', 'ALTER', 'CREATE', 'DELETE', 'DROP', 'INDEX', 'INSERT', 'LOCK', 'ROLE', 'SELECT', 'UPDATE']);
   
break;
case 2806:

     if (!$$[$0-1]) {
       parser.suggestKeywords(['ON', 'TO']);
     } else {
       parser.suggestKeywords(['TO']);
     }
   
break;
case 2809: case 2829: case 2831:

     if (!$$[$0-1]) {
       parser.suggestKeywords(['WITH GRANT OPTION']);
     }
   
break;
case 2814: case 2818:

     if (!$$[$0-1]) {
       parser.suggestKeywords(['WITH ADMIN OPTION']);
     }
   
break;
case 2820: case 2944:

     parser.suggestKeywords(['ALL', 'ALTER', 'CREATE', 'DROP', 'INSERT', 'REFRESH', 'ROLE', 'SELECT']);
   
break;
case 2821:

     parser.suggestKeywords(['TO GROUP']);
   
break;
case 2822: case 2946: case 3343: case 3344:

     parser.suggestKeywords(['GROUP']);
   
break;
case 2824: case 2948:

     if ($$[$0-1].isCreate) {
       parser.suggestKeywords(['ON DATABASE', 'ON SERVER']);
     } else {
       parser.suggestKeywords(['ON DATABASE', 'ON SERVER', 'ON TABLE', 'ON URI']);
     }
   
break;
case 2825:

     if ($$[$0-2].isCreate) {
        parser.suggestKeywords(['DATABASE', 'SERVER']);
     } else {
        parser.suggestKeywords(['DATABASE', 'SERVER', 'TABLE', 'URI']);
     }
   
break;
case 2828: case 2935: case 2952: case 3293:

     parser.suggestKeywords(['ROLE']);
   
break;
case 2835:

     parser.suggestKeywords(['DATABASE', 'TABLE']);
     parser.suggestTables();
     parser.suggestDatabases({ appendDot: true });
   
break;
case 2851:

     if ($$[$0].toUpperCase() === 'ALL') {
       this.$ = { singleAll: true };
     }
   
break;
case 2857: case 2858: case 2859: case 2922:

     parser.suggestKeywords(['ALL', 'ALTER', 'CREATE', 'DELETE', 'DROP', 'INDEX', 'INSERT', 'LOCK', 'SELECT', 'SHOW_DATABASE', 'UPDATE']);
   
break;
case 2875:
this.$ = { isCreate: true };
break;
case 2897:

     parser.suggestKeywords(['GRANT OPTION']);
   
break;
case 2898: case 2899: case 2903: case 2955:

     parser.suggestKeywords(['OPTION']);
   
break;
case 2902:

     parser.suggestKeywords(['ADMIN OPTION']);
   
break;
case 2914:

     parser.suggestKeywords(['ADMIN OPTION FOR', 'ALL', 'ALL GRANT OPTION FROM', 'ALL PRIVILEGES FROM', 'ALTER', 'CREATE', 'DELETE', 'DROP', 'GRANT OPTION FOR', 'INDEX', 'INSERT', 'LOCK', 'ROLE', 'SELECT', 'UPDATE']);
   
break;
case 2917:

     if (!$$[$0-1]) {
       if ($$[$0-2].singleAll) {
         parser.suggestKeywords(['FROM', 'GRANT OPTION', 'ON', 'PRIVILEGES FROM']);
       } else {
         parser.suggestKeywords(['FROM', 'ON']);
       }
     } else {
       parser.suggestKeywords(['FROM']);
     }
   
break;
case 2920:

     parser.suggestKeywords(['OPTION FOR']);
   
break;
case 2921: case 2934:

     parser.suggestKeywords(['FOR']);
   
break;
case 2925:

     if (!$$[$0-1]) {
       parser.suggestKeywords(['FROM', 'ON']);
     } else {
       parser.suggestKeywords(['FROM']);
     }
   
break;
case 2928:

     if ($$[$0-1].toUpperCase() === 'ADMIN') {
       parser.suggestKeywords(['FROM', 'OPTION FOR']);
     } else {
       parser.suggestKeywords(['FROM']);
     }
   
break;
case 2945:

     parser.suggestKeywords(['FROM GROUP']);
   
break;
case 2949:

     if ($$[$0-2].isCreate) {
       parser.suggestKeywords(['DATABASE', 'SERVER']);
     } else {
       parser.suggestKeywords(['DATABASE', 'SERVER', 'TABLE', 'URI']);
     }
   
break;
case 2966:

     var keywords = [];
     if ($$[$0-1].suggestKeywords) {
       keywords = parser.createWeightedKeywords($$[$0-1].suggestKeywords, 2).concat([{ value: 'SELECT', weight: 1}]);
     } else {
       keywords = ['SELECT'];
     }
     if ($$[$0-1].addValues) {
       keywords.push({ weight: 1.1, value: 'VALUES' });
     }
     if (keywords.length > 0) {
       parser.suggestKeywords(keywords);
     }
   
break;
case 2969:

     if (!$$[$0].keepTables) {
       delete parser.yy.result.suggestTables;
       delete parser.yy.result.suggestDatabases;
     }
   
break;
case 2973:

     parser.suggestKeywords(['INSERT INTO', 'INSERT OVERWRITE', 'SELECT']);
   
break;
case 2974:

     if ($$[$0-1].cursorAtEnd) {
       parser.checkForSelectListKeywords($$[$0-1]);
       var keywords = parser.yy.result.suggestKeywords || [];
       if ($$[$0].suggestKeywords) {
         keywords = keywords.concat($$[$0].suggestKeywords);
       }
       if (keywords.length > 0) {
         parser.suggestKeywords(keywords);
       }
     }
     delete parser.yy.result.suggestTables;
     delete parser.yy.result.suggestDatabases;
   
break;
case 2975:

     if ($$[$0].cursorAtStart) {
       parser.checkForSelectListKeywords($$[$0-1].tableExpression);
     }
   
break;
case 2976:

     $$[$0-2].owner = 'insert';
     parser.addTablePrimary($$[$0-2]);
     if (!$$[$0-1] && !$$[$0]) {
       this.$ = { suggestKeywords: ['PARTITION'] }
     } else if (!$$[$0]) {
       this.$ = { suggestKeywords: ['IF NOT EXISTS'] }
     }
   
break;
case 2977:

     if (!$$[$0-1] && !$$[$0]) {
       this.$ = { suggestKeywords: [{ value: 'ROW FORMAT', weight: 2 }, { value: 'STORED AS', weight: 1}] };
     } else if (!$$[$0]) {
       this.$ = { suggestKeywords: ['STORED AS'] };
     }
   
break;
case 2978:

      if (!$$[$0-1] && !$$[$0]) {
        this.$ = { suggestKeywords: [{ value: 'ROW FORMAT', weight: 2 }, { value: 'STORED AS', weight: 1}] };
      } else if (!$$[$0]) {
        this.$ = { suggestKeywords: ['STORED AS'] };
      }
    
break;
case 2979:

     $$[$0-2].owner = 'insert';
     parser.addTablePrimary($$[$0-2]);
     if (!$$[$0-1] && !$$[$0]) {
       this.$ = { suggestKeywords: ['PARTITION'], addValues: true };
     } else if (!$$[$0]) {
       this.$ = { addValues: true };
     }
   
break;
case 2980:

     parser.suggestKeywords(['OVERWRITE', 'INTO']);
   
break;
case 2981:

     if (!$$[$0-1]) {
       parser.suggestKeywords(['DIRECTORY', 'LOCAL DIRECTORY', 'TABLE']);
     }
     parser.suggestTables();
     parser.suggestDatabases({ appendDot: true });
     this.$ = { keepTables: true }
   
break;
case 2982: case 2993:

     this.$ = { keepTables: true }
   
break;
case 2983: case 2994: case 2995: case 3058: case 3059:

     $$[$0-2].owner = 'insert';
     parser.addTablePrimary($$[$0-2]);
     if (parser.yy.result.suggestColumns) {
       parser.yy.result.suggestColumns.owner = 'insert';
     }
   
break;
case 2984: case 3010:

     $$[$0-2].owner = 'insert';
     parser.addTablePrimary($$[$0-2]);
   
break;
case 2985:

     parser.suggestKeywords(['DIRECTORY']);
   
break;
case 2992:

     if (!$$[$0-1]) {
       parser.suggestKeywords(['TABLE']);
     }
     parser.suggestTables();
     parser.suggestDatabases({ appendDot: true });
     this.$ = { keepTables: true }
   
break;
case 3005:

     if ($$[$0-1].suggestKeywords) {
       parser.suggestKeywords(parser.createWeightedKeywords($$[$0-1].suggestKeywords, 2).concat([{ value: 'SELECT', weight: 1}]));
     } else {
       parser.suggestKeywords(['SELECT']);
     }
   
break;
case 3006:

     if ($$[$0-1].cursorAtEnd) {
       parser.checkForSelectListKeywords($$[$0-1]);
       var keywords = parser.yy.result.suggestKeywords || [];
       if ($$[$0].suggestKeywords) {
         keywords = keywords.concat($$[$0].suggestKeywords);
       }
       if (keywords.length > 0) {
         parser.suggestKeywords(keywords);
       }
     }
   
break;
case 3008: case 3009:

     $$[$0-3].owner = 'insert';
     parser.addTablePrimary($$[$0-3]);
   
break;
case 3011: case 3048: case 3084:

     parser.suggestKeywords(['INTO']);
   
break;
case 3012: case 3049: case 3055:

     if (!$$[$0-1]) {
       parser.suggestKeywords(['TABLE']);
     }
     parser.suggestTables();
     parser.suggestDatabases({ appendDot: true });
   
break;
case 3014:

     $$[$0-1].owner = 'insert';
     parser.addTablePrimary($$[$0-1]);
     parser.suggestKeywords(['VALUES']);
   
break;
case 3023:

     parser.suggestKeywords(['FORMAT DELIMITED']);
   
break;
case 3026:
this.$ = { selectList: $$[$0] };
break;
case 3027:

     this.$ = $$[$0-1];
     this.$.cursorAtEnd = true;
   
break;
case 3028:

     parser.selectListNoTableSuggest($$[$0], $$[$0-2]);
   
break;
case 3029:

     var keywords = parser.getSelectListKeywords();
     if (!$$[$0-2] || $$[$0-2] === 'ALL') {
       parser.suggestAggregateFunctions();
       parser.suggestAnalyticFunctions();
     }
     if (!$$[$0-1] && !$$[$0-2]) {
       keywords.push({ value: 'ALL', weight: 2 });
       keywords.push({ value: 'DISTINCT', weight: 2 });
     }
     if (parser.isImpala() && !$$[$0-1]) {
       keywords.push({ value: 'STRAIGHT_JOIN', weight: 1 });
     }
     parser.suggestKeywords(keywords);
     parser.suggestFunctions();
     parser.suggestColumns();
   
break;
case 3037:

     var keywords = $$[$0-2].suggestKeywords && !$$[$0-1] ? parser.createWeightedKeywords($$[$0-2].suggestKeywords, 2) : [];
     if (!$$[$0-1]) {
       keywords = keywords.concat(['[NOSHUFFLE]', '[SHUFFLE]', 'SELECT', 'VALUES'])
     } else {
       keywords = keywords.concat(['SELECT'])
     }
     parser.suggestKeywords(keywords);
   
break;
case 3047:

     $$[$0-1].owner = 'upsert';
     parser.addTablePrimary($$[$0-1]);
   
break;
case 3050:

     if (!$$[$0-3]) {
       parser.suggestKeywords(['TABLE']);
     }
     $$[$0-1].owner = 'upsert';
     parser.addTablePrimary($$[$0-1]);
   
break;
case 3052:

     $$[$0-1].owner = 'upsert';
     parser.addTablePrimary($$[$0-1]);
     if (parser.yy.result.suggestColumns) {
       parser.yy.result.suggestColumns.owner = 'upsert';
     }
   
break;
case 3053:

     $$[$0-2].owner = 'insert';
     parser.addTablePrimary($$[$0-2]);
     if (!$$[$0]) {
       this.$ = { suggestKeywords: ['PARTITION'] };
     }
   
break;
case 3054:

     parser.suggestKeywords(['INTO', 'OVERWRITE']);
   
break;
case 3056:

     if (!$$[$0-4]) {
       parser.suggestKeywords(['TABLE']);
     }
     $$[$0-2].owner = 'insert';
     parser.addTablePrimary($$[$0-2]);
   
break;
case 3081:

     parser.suggestValueExpressionKeywords($$[$0-1], [{ value: 'WHEN', weight: 2 }]);
   
break;
case 3083:

     $$[$0-6].alias = $$[$0-4];
     parser.addTablePrimary($$[$0-6]);
     if ($$[$0-2].subQuery) {
       parser.addTablePrimary({ subQueryAlias: $$[$0] });
     } else {
       $$[$0-2].alias = $$[$0];
     }
   
break;
case 3085:

     parser.suggestDatabases({ appendDot: true });
     parser.suggestTables();
   
break;
case 3087:

     parser.addTablePrimary($$[$0-1]);
     parser.suggestKeywords(['AS T USING']);
   
break;
case 3088:

     parser.addTablePrimary($$[$0-2]);
     parser.suggestKeywords(['T USING']);
   
break;
case 3089:

     $$[$0-3].alias = $$[$0-1];
     parser.addTablePrimary($$[$0-3]);
     parser.suggestKeywords(['USING']);
   
break;
case 3090:

     $$[$0-4].alias = $$[$0-2];
     parser.addTablePrimary($$[$0-4]);
     parser.suggestDatabases({ appendDot: true });
     parser.suggestTables();
   
break;
case 3091:

     $$[$0-4].alias = $$[$0-2];
     parser.addTablePrimary($$[$0-4]);
   
break;
case 3092:

     $$[$0-5].alias = $$[$0-3];
     parser.addTablePrimary($$[$0-5]);
     parser.suggestKeywords(['AS S ON']);
   
break;
case 3093:

     $$[$0-6].alias = $$[$0-4];
     parser.addTablePrimary($$[$0-6]);
     parser.suggestKeywords(['S ON']);
   
break;
case 3102:

     if ($$[$0].suggestThenKeywords) {
       parser.suggestKeywords(['DELETE', 'INSERT VALUES', 'UPDATE SET']);
     }
   
break;
case 3103: case 3105:

     if (!$$[$0-1].notPresent) {
       parser.suggestKeywords(['WHEN']);
     }
   
break;
case 3104:

     if (!$$[$0-1].notPresent && $$[$0].suggestThenKeywords) {
       var keywords = [];
       if (!$$[$0-1].isDelete) {
         keywords.push('DELETE');
       }
       if (!$$[$0-1].isInsert) {
         keywords.push('INSERT VALUES');
       }
       if (!$$[$0-1].isUpdate) {
         keywords.push('UPDATE SET');
       }
       parser.suggestKeywords(keywords);
     }
   
break;
case 3106:

     if (!$$[$0-1].notPresent && $$[$0].suggestThenKeywords) {
       var keywords = [];
       if (!$$[$0-2].isDelete && !$$[$0-1].isDelete) {
         keywords.push('DELETE');
       }
       if (!$$[$0-2].isInsert && !$$[$0-1].isInsert) {
         keywords.push('INSERT VALUES');
       }
       if (!$$[$0-2].isUpdate && !$$[$0-1].isUpdate) {
         keywords.push('UPDATE SET');
       }
       parser.suggestKeywords(keywords);
     }
   
break;
case 3107:
this.$ = { notPresent: !!$$[$0-4], isDelete: $$[$0].isDelete, isInsert: $$[$0].isInsert, isUpdate: $$[$0].isUpdate };
break;
case 3108:

     if (!$$[$0-1]) {
       parser.suggestKeywords(['NOT MATCHED', 'MATCHED']);
     } else {
       parser.suggestKeywords(['MATCHED']);
     }
   
break;
case 3109:

     if (!$$[$0-1]) {
       parser.suggestKeywords(['AND', 'THEN']);
     } else {
       parser.suggestValueExpressionKeywords($$[$0-1], [{ value: 'THEN', weight: 2 }]);
     }
   
break;
case 3111:
this.$ = { suggestThenKeywords: true };
break;
case 3116:
this.$ = { isUpdate: true };
break;
case 3117:
this.$ = { isDelete: true };
break;
case 3118:
this.$ = { isInsert: true };
break;
case 3119:

     parser.suggestKeywords(['SET']);
   
break;
case 3123:

     if (parser.isHive()) {
       parser.suggestKeywords(['DATA LOCAL INPATH', 'DATA INPATH']);
     } else if (parser.isImpala()) {
       parser.suggestKeywords(['DATA INPATH']);
     }
   
break;
case 3124:

     if (parser.isHive() && !$$[$0-1]) {
       parser.suggestKeywords(['INPATH', 'LOCAL INPATH']);
     } else {
       parser.suggestKeywords(['INPATH']);
     }
   
break;
case 3126:

     if (!$$[$0-1]) {
       parser.suggestKeywords(['OVERWRITE INTO TABLE', 'INTO TABLE']);
     } else {
       parser.suggestKeywords(['INTO TABLE']);
     }
   
break;
case 3127:

     parser.suggestKeywords([ 'TABLE' ]);
   
break;
case 3145:

     if (!$$[$0]) {
       parser.suggestKeywords(['EXTERNAL TABLE', 'FROM', 'TABLE']);
     } else if (!$$[$0].hasExternal) {
       parser.suggestKeywords(['EXTERNAL']);
     }
   
break;
case 3146:

     if ($$[$0-1].suggestKeywords) {
        parser.suggestKeywords(parser.createWeightedKeywords($$[$0-1].suggestKeywords, 2).concat(['FROM']));
      } else {
        parser.suggestKeywords(['FROM']);
      }
   
break;
case 3150:

     if (!$$[$0-1]) {
       parser.suggestKeywords(['LOCATION']);
     }
   
break;
case 3151:

     if (!$$[$0-4]) {
       parser.suggestKeywords(['EXTERNAL TABLE', 'TABLE']);
     } else if (!$$[$0-4].hasExternal) {
       parser.suggestKeywords(['EXTERNAL']);
     }
   
break;
case 3153:

      if ($$[$0-5].suggestKeywords) {
        parser.suggestKeywords(parser.createWeightedKeywords($$[$0-5].suggestKeywords, 2).concat(['FROM']));
      }
    
break;
case 3156:

     parser.addTablePrimary($$[$0-1]);
     if (!$$[$0]) {
       this.$ = { hasExternal: true, suggestKeywords: ['PARTITION'] };
     } else {
       this.$ = { hasExternal: true }
     }
   
break;
case 3157:

     parser.addTablePrimary($$[$0-1]);
     if (!$$[$0]) {
       this.$ = { suggestKeywords: ['PARTITION'] };
     }
   
break;
case 3166: case 3180: case 3181:

     parser.addTablePrimary($$[$0-9]);
   
break;
case 3170:

     parser.addTablePrimary($$[$0-2]);
     if (!$$[$0-1]) {
       parser.suggestKeywords([{ weight: 2, value: 'PARTITION' }, { weight: 1, value: 'TO' }]);
     } else {
       parser.suggestKeywords([ 'TO' ]);
     }
   
break;
case 3173:

     parser.addTablePrimary($$[$0-5]);
     parser.suggestKeywords(['FOR replication()']);
   
break;
case 3174:

     parser.addTablePrimary($$[$0-6]);
     parser.suggestKeywords(['replication()']);
   
break;
case 3177:

     parser.addTablePrimary($$[$0-5]);
     if (!$$[$0-4]) {
       parser.suggestKeywords(['PARTITION']);
     }
   
break;
case 3178:

     parser.addTablePrimary($$[$0-10]);
     if (!$$[$0-9]) {
       parser.suggestKeywords(['PARTITION']);
     }
   
break;
case 3194:

     parser.suggestKeywords(['ALL', 'NONE']);
   
break;
case 3217:

     if (parser.isHive()) {
       parser.suggestKeywords(['COLUMNS', 'COMPACTIONS', 'CONF', 'CREATE TABLE', 'CURRENT ROLES', 'DATABASES', 'FORMATTED', 'FUNCTIONS', 'GRANT', 'INDEX', 'INDEXES', 'LOCKS', 'PARTITIONS', 'PRINCIPALS', 'ROLE GRANT', 'ROLES', 'SCHEMAS', 'TABLE EXTENDED', 'TABLES', 'TBLPROPERTIES', 'TRANSACTIONS', 'VIEWS']);
     } else if (parser.isImpala()) {
       parser.suggestKeywords(['AGGREGATE FUNCTIONS', 'ANALYTIC FUNCTIONS', 'COLUMN STATS', 'CREATE TABLE', 'CURRENT ROLES', 'DATABASES', 'FILES IN', 'FUNCTIONS', 'GRANT ROLE', 'PARTITIONS', 'RANGE PARTITIONS', 'ROLE GRANT GROUP', 'ROLES', 'SCHEMAS', 'TABLE STATS', 'TABLES']);
     } else {
       parser.suggestKeywords(['COLUMNS', 'DATABASES', 'TABLES']);
     }
   
break;
case 3218:

     // ROLES is considered a non-reserved keywords so we can't match it in ShowCurrentRolesStatement_EDIT
     if ($$[$0].identifierChain && $$[$0].identifierChain.length === 1 && $$[$0].identifierChain[0].name.toLowerCase() === 'roles') {
       parser.suggestKeywords(['CURRENT']);
       parser.yy.locations.pop();
     } else {
       parser.addTablePrimary($$[$0]);
       if (parser.isImpala()) {
         parser.suggestKeywords(['COLUMN STATS', 'CREATE TABLE', 'FILES IN', 'PARTITIONS', 'RANGE PARTITIONS', 'TABLE STATS']);
       }
     }
   
break;
case 3219:

     if (parser.isImpala()) {
       parser.suggestKeywords(['AGGREGATE FUNCTIONS', 'ANALYTIC FUNCTIONS', 'DATABASES', 'FUNCTIONS', 'SCHEMAS', 'TABLES']);
     } else if (parser.isHive()) {
       parser.suggestKeywords(['DATABASES', 'SCHEMAS', 'TABLE EXTENDED']);
     }
   
break;
case 3238: case 3268: case 3328: case 3332: case 3334: case 3362:

     parser.suggestTables();
     parser.suggestDatabases({
       appendDot: true
     });
   
break;
case 3242: case 3243: case 3247: case 3248: case 3307: case 3308:

     parser.suggestKeywords(['FROM', 'IN']);
   
break;
case 3244: case 3245: case 3246: case 3291: case 3305:

     parser.suggestTables();
   
break;
case 3253:

     if (parser.isImpala()) {
       parser.suggestKeywords(['TABLE', 'VIEW']);
     } else {
       parser.suggestKeywords(['TABLE']);
     }
   
break;
case 3254:

     if ($$[$0-1].isView && parser.isImpala()) {
       parser.suggestTables({ onlyViews: true });
     } else {
       parser.suggestTables();
     }
     parser.suggestDatabases({
       appendDot: true
     });
   
break;
case 3255:

     if (parser.yy.result.suggestTables && $$[$0-1].isView) {
       parser.yy.result.suggestTables.onlyViews = true;
     }
   
break;
case 3256:

     parser.addTablePrimary($$[$0]);
     if (parser.isImpala()) {
       parser.suggestKeywords(['TABLE', 'VIEW']);
     } else {
       parser.suggestKeywords(['TABLE']);
     }
   
break;
case 3258:
this.$ = { isView: true };
break;
case 3261: case 3262:

     parser.suggestKeywords([ 'ROLES' ]);
   
break;
case 3265: case 3359:

     parser.suggestKeywords(['LIKE']);
   
break;
case 3272:

     parser.addTablePrimary($$[$0-1]);
     parser.suggestKeywords(['IN']);
   
break;
case 3277: case 3280:

     parser.suggestKeywords(['FUNCTIONS']);
   
break;
case 3278: case 3281:

     parser.suggestKeywords(['AGGREGATE', 'ANALYTICAL']);
   
break;
case 3279: case 3368:

     if (!$$[$0-1]) {
       parser.suggestKeywords(['IN', 'LIKE']);
     } else {
       parser.suggestKeywords(['LIKE']);
     }
   
break;
case 3282:

     if (!$$[$0-2]) {
       parser.suggestKeywords([{ value: 'IN', weight: 2 }, { value: 'LIKE', weight: 1 }]);
     } else {
       parser.suggestKeywords(['LIKE']);
     }
   
break;
case 3290:

     parser.suggestKeywords(['ALL', 'TABLE']);
     parser.suggestTables();
   
break;
case 3310:

     parser.suggestTables({identifierChain: [{name: $$[$0]}]});
   
break;
case 3316:

     parser.suggestTables();
     parser.suggestDatabases({
       appendDot: true
     });
     parser.suggestKeywords(['DATABASE', 'SCHEMA']);
   
break;
case 3318:

      parser.addTablePrimary($$[$0-1]);
      parser.suggestKeywords(['EXTENDED', 'PARTITION']);
    
break;
case 3321:

     parser.addTablePrimary($$[$0-2]);
     parser.suggestKeywords(['EXTENDED']);
   
break;
case 3338: case 3339: case 3340:

     parser.suggestKeywords(['GRANT']);
   
break;
case 3341: case 3342:

     parser.suggestKeywords(['ROLE', 'USER']);
   
break;
case 3349: case 3358:

     parser.suggestKeywords(['EXTENDED']);
   
break;
case 3352:

      if ($$[$0-1]) {
        parser.suggestKeywords(['LIKE']);
      } else {
        parser.suggestKeywords(['FROM', 'IN', 'LIKE']);
      }
    
break;
case 3354:

      if (parser.isHive()) {
        parser.suggestKeywords(['EXTENDED']);
      }
    
break;
case 3355:

      parser.suggestKeywords(['LIKE']);
    
break;
case 3356:

      parser.suggestKeywords(['PARTITION']);
    
break;
case 3363:

      parser.addTablePrimary($$[$0]);
    
break;
case 3370:

     parser.addTablePrimary($$[$0-3]);
   
break;
case 3375:

     if (!$$[$0-1] && !$$[$0-2]) {
       parser.suggestKeywords([{ value: 'IN', weight: 2 }, { value: 'FROM', weight: 2 }, { value: 'LIKE', weight: 1 }]);
     } else if (!$$[$0-1]) {
       parser.suggestKeywords(['LIKE']);
     }
   
break;
case 3379: case 3380:

     parser.addDatabaseLocation(_$[$0], [ { name: $$[$0] } ]);
   
break;
case 3391:

     if (parser.isImpala() && !$$[$0-1] && !$$[$0-2]) {
       parser.suggestKeywords([{ value: 'FROM', weight: 2 }, { value: 'WHERE', weight: 1 }]);
     } else if (parser.isImpala() && !$$[$0-1] && $$[$0-2]) {
       var keywords = [{ value: 'FULL JOIN', weight: 2 }, { value: 'FULL OUTER JOIN', weight: 2 }, { value: 'JOIN', weight: 2 }, { value: 'LEFT JOIN', weight: 2 }, { value: 'LEFT OUTER JOIN', weight: 2 }, { value: 'RIGHT JOIN', weight: 2 }, { value: 'RIGHT OUTER JOIN', weight: 2 }, { value: 'INNER JOIN', weight: 2 },  { value: 'LEFT ANTI JOIN', weight: 2 }, { value: 'LEFT SEMI JOIN', weight: 2 }, { value: 'RIGHT ANTI JOIN', weight: 2 }, { value: 'RIGHT SEMI JOIN', weight: 2 }, { value: 'WHERE', weight: 1 }];
       if ($$[$0-2].suggestJoinConditions) {
         parser.suggestJoinConditions($$[$0-2].suggestJoinConditions);
       }
       if ($$[$0-2].suggestJoins) {
         parser.suggestJoins($$[$0-2].suggestJoins);
       }
       if ($$[$0-2].suggestKeywords) {
         keywords = keywords.concat(parser.createWeightedKeywords($$[$0-2].suggestKeywords, 3));
       }
       parser.suggestKeywords(keywords);
     } else if (!$$[$0-1]) {
       parser.suggestKeywords([ 'WHERE' ]);
     }
   
break;
case 3392:

     parser.suggestKeywords([ 'SET' ]);
   
break;
case 3408:

     parser.suggestKeywords([ '=' ]);
   
break;
case 3419:

     if (! parser.yy.cursorFound) {
       parser.yy.result.useDatabase = $$[$0];
     }
   
break;
}
},
defaultActions: {13:[2,178],14:[2,179],15:[2,180],16:[2,181],17:[2,182],18:[2,183],19:[2,184],20:[2,185],21:[2,186],22:[2,187],23:[2,188],24:[2,189],25:[2,190],26:[2,191],27:[2,192],28:[2,193],29:[2,194],30:[2,195],31:[2,196],32:[2,197],33:[2,198],34:[2,199],35:[2,200],36:[2,201],37:[2,202],38:[2,203],39:[2,204],40:[2,205],41:[2,206],42:[2,207],43:[2,208],44:[2,209],45:[2,210],46:[2,211],47:[2,212],49:[2,214],50:[2,215],51:[2,216],52:[2,217],53:[2,218],54:[2,219],55:[2,220],56:[2,221],57:[2,222],58:[2,223],59:[2,224],60:[2,225],61:[2,226],62:[2,227],63:[2,228],64:[2,229],65:[2,230],66:[2,231],67:[2,232],68:[2,233],69:[2,234],70:[2,235],71:[2,236],72:[2,237],73:[2,238],74:[2,239],75:[2,240],76:[2,241],77:[2,242],78:[2,243],79:[2,244],80:[2,245],81:[2,246],82:[2,247],83:[2,248],84:[2,249],85:[2,250],86:[2,251],87:[2,252],88:[2,253],89:[2,254],90:[2,255],91:[2,256],92:[2,257],93:[2,258],94:[2,259],95:[2,260],96:[2,261],97:[2,262],98:[2,263],99:[2,264],100:[2,265],101:[2,266],102:[2,267],103:[2,268],104:[2,269],105:[2,270],106:[2,271],107:[2,272],108:[2,273],109:[2,274],110:[2,275],111:[2,276],112:[2,277],113:[2,278],114:[2,279],115:[2,280],116:[2,281],117:[2,282],118:[2,283],119:[2,284],120:[2,285],121:[2,286],122:[2,287],123:[2,288],124:[2,289],125:[2,290],126:[2,291],127:[2,292],128:[2,293],129:[2,294],130:[2,295],131:[2,296],132:[2,297],133:[2,298],134:[2,299],135:[2,300],136:[2,301],137:[2,302],138:[2,303],139:[2,304],140:[2,305],141:[2,306],142:[2,307],143:[2,308],145:[2,310],146:[2,311],147:[2,312],148:[2,313],149:[2,314],150:[2,315],151:[2,316],152:[2,317],153:[2,318],154:[2,319],155:[2,320],156:[2,321],157:[2,322],158:[2,323],159:[2,324],160:[2,325],161:[2,326],162:[2,327],163:[2,328],164:[2,329],165:[2,330],166:[2,331],167:[2,332],168:[2,333],169:[2,334],170:[2,335],171:[2,336],172:[2,337],173:[2,338],174:[2,339],175:[2,340],176:[2,341],177:[2,342],178:[2,343],179:[2,344],180:[2,345],181:[2,346],182:[2,347],183:[2,348],184:[2,349],185:[2,350],186:[2,351],187:[2,352],188:[2,353],189:[2,354],190:[2,355],191:[2,356],192:[2,357],193:[2,358],194:[2,359],195:[2,360],196:[2,361],197:[2,362],198:[2,363],200:[2,365],201:[2,366],202:[2,367],203:[2,368],204:[2,369],205:[2,370],206:[2,371],207:[2,372],208:[2,373],209:[2,374],210:[2,375],211:[2,376],212:[2,377],213:[2,378],214:[2,379],215:[2,380],216:[2,381],217:[2,382],218:[2,383],219:[2,384],220:[2,385],221:[2,386],222:[2,387],223:[2,388],224:[2,389],225:[2,390],226:[2,391],227:[2,392],228:[2,393],229:[2,394],230:[2,395],231:[2,396],232:[2,397],233:[2,398],234:[2,399],235:[2,400],236:[2,401],237:[2,402],238:[2,403],239:[2,404],240:[2,405],241:[2,406],243:[2,408],244:[2,409],245:[2,410],246:[2,411],247:[2,412],248:[2,413],249:[2,414],250:[2,415],251:[2,416],252:[2,417],253:[2,418],254:[2,419],255:[2,420],256:[2,421],257:[2,422],258:[2,423],259:[2,424],260:[2,425],261:[2,426],262:[2,427],263:[2,428],264:[2,429],265:[2,430],266:[2,431],267:[2,432],268:[2,433],269:[2,434],270:[2,435],271:[2,436],272:[2,437],273:[2,438],274:[2,439],276:[2,441],277:[2,442],278:[2,443],279:[2,444],280:[2,445],281:[2,446],282:[2,447],283:[2,448],284:[2,449],285:[2,450],286:[2,451],287:[2,452],288:[2,453],290:[2,455],291:[2,456],292:[2,457],293:[2,458],294:[2,459],295:[2,460],296:[2,461],297:[2,462],298:[2,463],299:[2,464],300:[2,465],301:[2,466],302:[2,467],303:[2,468],304:[2,469],305:[2,470],306:[2,471],307:[2,472],308:[2,473],309:[2,474],310:[2,475],311:[2,476],312:[2,477],313:[2,478],314:[2,479],315:[2,480],316:[2,481],317:[2,482],318:[2,483],319:[2,484],320:[2,485],321:[2,486],322:[2,487],323:[2,488],324:[2,489],325:[2,490],326:[2,491],327:[2,492],328:[2,493],329:[2,494],330:[2,495],331:[2,496],332:[2,497],333:[2,498],334:[2,499],335:[2,500],336:[2,501],337:[2,502],338:[2,503],339:[2,504],340:[2,505],341:[2,506],342:[2,507],343:[2,508],344:[2,509],345:[2,510],346:[2,511],347:[2,512],348:[2,513],349:[2,514],350:[2,515],351:[2,516],352:[2,517],571:[2,2],573:[2,3],1344:[2,624],1611:[2,1440],1612:[2,1441],1613:[2,1442],1614:[2,1443],1615:[2,1444],1616:[2,1445],1655:[2,1574],1656:[2,1575],1657:[2,1576],1658:[2,1577],1659:[2,1578],1660:[2,1579],1661:[2,1580],1662:[2,1581],1663:[2,1582],1664:[2,1583],1665:[2,1584],1666:[2,1585],1667:[2,1586],1668:[2,1587],1669:[2,1588],1670:[2,1589],1671:[2,1590],1672:[2,1591],1673:[2,1592],1674:[2,1593],1675:[2,1594],1676:[2,1595],1677:[2,1596],1724:[2,607],1725:[2,608],1726:[2,1971],1727:[2,1972],1729:[2,597],1730:[2,598],1771:[2,1907],1772:[2,1908],2179:[2,3142],2180:[2,3143],3743:[2,1704],3784:[2,2600],4044:[2,2295],4372:[2,2117],4373:[2,2116],4409:[2,2546],4431:[2,2580],4432:[2,2581],4433:[2,2582],4702:[2,2257],4842:[2,1705],5132:[2,2289],5180:[2,1701],5425:[2,2259],5480:[2,1706],5482:[2,1709],5640:[2,587],5641:[2,588],5858:[2,2260]},
parseError: function parseError(str, hash) {
    if (hash.recoverable) {
        this.trace(str);
    } else {
        var error = new Error(str);
        error.hash = hash;
        throw error;
    }
},
parse: function parse(input) {
    var self = this,
        stack = [0],
        tstack = [], // token stack
        vstack = [null], // semantic value stack
        lstack = [], // location stack
        table = this.table,
        yytext = '',
        yylineno = 0,
        yyleng = 0,
        recovering = 0,
        TERROR = 2,
        EOF = 1;

    var args = lstack.slice.call(arguments, 1);

    //this.reductionCount = this.shiftCount = 0;

    var lexer = Object.create(this.lexer);
    var sharedState = { yy: {} };
    // copy state
    for (var k in this.yy) {
      if (Object.prototype.hasOwnProperty.call(this.yy, k)) {
        sharedState.yy[k] = this.yy[k];
      }
    }

    lexer.setInput(input, sharedState.yy);
    sharedState.yy.lexer = lexer;
    sharedState.yy.parser = this;
    if (typeof lexer.yylloc == 'undefined') {
        lexer.yylloc = {};
    }
    var yyloc = lexer.yylloc;
    lstack.push(yyloc);

    var ranges = lexer.options && lexer.options.ranges;

    if (typeof sharedState.yy.parseError === 'function') {
        this.parseError = sharedState.yy.parseError;
    } else {
        this.parseError = Object.getPrototypeOf(this).parseError;
    }

    function popStack (n) {
        stack.length = stack.length - 2 * n;
        vstack.length = vstack.length - n;
        lstack.length = lstack.length - n;
    }

_token_stack:
    var lex = function () {
        var token;
        token = lexer.lex() || EOF;
        // if token isn't its numeric value, convert
        if (typeof token !== 'number') {
            token = self.symbols_[token] || token;
        }
        return token;
    }

    var symbol, preErrorSymbol, state, action, a, r, yyval = {}, p, len, newState, expected;
    while (true) {
        // retreive state number from top of stack
        state = stack[stack.length - 1];

        // use default actions if available
        if (this.defaultActions[state]) {
            action = this.defaultActions[state];
        } else {
            if (symbol === null || typeof symbol == 'undefined') {
                symbol = lex();
            }
            // read action for current state and first input
            action = table[state] && table[state][symbol];
        }

_handle_error:
        // handle parse error
        if (typeof action === 'undefined' || !action.length || !action[0]) {
            var error_rule_depth;
            var errStr = '';

            // Return the rule stack depth where the nearest error rule can be found.
            // Return FALSE when no error recovery rule was found.
            function locateNearestErrorRecoveryRule(state) {
                var stack_probe = stack.length - 1;
                var depth = 0;

                // try to recover from error
                for(;;) {
                    // check for error recovery rule in this state
                    if ((TERROR.toString()) in table[state]) {
                        return depth;
                    }
                    if (state === 0 || stack_probe < 2) {
                        return false; // No suitable error recovery rule available.
                    }
                    stack_probe -= 2; // popStack(1): [symbol, action]
                    state = stack[stack_probe];
                    ++depth;
                }
            }

            if (!recovering) {
                // first see if there's any chance at hitting an error recovery rule:
                error_rule_depth = locateNearestErrorRecoveryRule(state);

                // Report error
                expected = [];
                for (p in table[state]) {
                    if (this.terminals_[p] && p > TERROR) {
                        expected.push("'"+this.terminals_[p]+"'");
                    }
                }
                if (lexer.showPosition) {
                    errStr = 'Parse error on line '+(yylineno+1)+":\n"+lexer.showPosition()+"\nExpecting "+expected.join(', ') + ", got '" + (this.terminals_[symbol] || symbol)+ "'";
                } else {
                    errStr = 'Parse error on line '+(yylineno+1)+": Unexpected " +
                                  (symbol == EOF ? "end of input" :
                                              ("'"+(this.terminals_[symbol] || symbol)+"'"));
                }
                this.parseError(errStr, {
                    text: lexer.match,
                    token: this.terminals_[symbol] || symbol,
                    line: lexer.yylineno,
                    loc: yyloc,
                    expected: expected,
                    recoverable: (error_rule_depth !== false)
                });
            } else if (preErrorSymbol !== EOF) {
                error_rule_depth = locateNearestErrorRecoveryRule(state);
            }

            // just recovered from another error
            if (recovering == 3) {
                if (symbol === EOF || preErrorSymbol === EOF) {
                    throw new Error(errStr || 'Parsing halted while starting to recover from another error.');
                }

                // discard current lookahead and grab another
                yyleng = lexer.yyleng;
                yytext = lexer.yytext;
                yylineno = lexer.yylineno;
                yyloc = lexer.yylloc;
                symbol = lex();
            }

            // try to recover from error
            if (error_rule_depth === false) {
                throw new Error(errStr || 'Parsing halted. No suitable error recovery rule available.');
            }
            popStack(error_rule_depth);

            preErrorSymbol = (symbol == TERROR ? null : symbol); // save the lookahead token
            symbol = TERROR;         // insert generic error symbol as new lookahead
            state = stack[stack.length-1];
            action = table[state] && table[state][TERROR];
            recovering = 3; // allow 3 real symbols to be shifted before reporting a new error
        }

        // this shouldn't happen, unless resolve defaults are off
        if (action[0] instanceof Array && action.length > 1) {
            throw new Error('Parse Error: multiple actions possible at state: '+state+', token: '+symbol);
        }

        switch (action[0]) {
            case 1: // shift
                //this.shiftCount++;

                stack.push(symbol);
                vstack.push(lexer.yytext);
                lstack.push(lexer.yylloc);
                stack.push(action[1]); // push state
                symbol = null;
                if (!preErrorSymbol) { // normal execution/no error
                    yyleng = lexer.yyleng;
                    yytext = lexer.yytext;
                    yylineno = lexer.yylineno;
                    yyloc = lexer.yylloc;
                    if (recovering > 0) {
                        recovering--;
                    }
                } else {
                    // error just occurred, resume old lookahead f/ before error
                    symbol = preErrorSymbol;
                    preErrorSymbol = null;
                }
                break;

            case 2:
                // reduce
                //this.reductionCount++;

                len = this.productions_[action[1]][1];

                // perform semantic action
                yyval.$ = vstack[vstack.length-len]; // default to $$ = $1
                // default location, uses first token for firsts, last for lasts
                yyval._$ = {
                    first_line: lstack[lstack.length-(len||1)].first_line,
                    last_line: lstack[lstack.length-1].last_line,
                    first_column: lstack[lstack.length-(len||1)].first_column,
                    last_column: lstack[lstack.length-1].last_column
                };
                if (ranges) {
                  yyval._$.range = [lstack[lstack.length-(len||1)].range[0], lstack[lstack.length-1].range[1]];
                }
                r = this.performAction.apply(yyval, [yytext, yyleng, yylineno, sharedState.yy, action[1], vstack, lstack].concat(args));

                if (typeof r !== 'undefined') {
                    return r;
                }

                // pop off stack
                if (len) {
                    stack = stack.slice(0,-1*len*2);
                    vstack = vstack.slice(0, -1*len);
                    lstack = lstack.slice(0, -1*len);
                }

                stack.push(this.productions_[action[1]][0]);    // push nonterminal (reduce)
                vstack.push(yyval.$);
                lstack.push(yyval._$);
                // goto new state = table[STATE][NONTERMINAL]
                newState = table[stack[stack.length-2]][stack[stack.length-1]];
                stack.push(newState);
                break;

            case 3:
                // accept
                return true;
        }

    }

    return true;
}};


SqlParseSupport.initSqlParser(parser);/* generated by jison-lex 0.3.4 */
var lexer = (function(){
var lexer = ({

EOF:1,

parseError:function parseError(str, hash) {
        if (this.yy.parser) {
            this.yy.parser.parseError(str, hash);
        } else {
            throw new Error(str);
        }
    },

// resets the lexer, sets new input
setInput:function (input, yy) {
        this.yy = yy || this.yy || {};
        this._input = input;
        this._more = this._backtrack = this.done = false;
        this.yylineno = this.yyleng = 0;
        this.yytext = this.matched = this.match = '';
        this.conditionStack = ['INITIAL'];
        this.yylloc = {
            first_line: 1,
            first_column: 0,
            last_line: 1,
            last_column: 0
        };
        if (this.options.ranges) {
            this.yylloc.range = [0,0];
        }
        this.offset = 0;
        return this;
    },

// consumes and returns one char from the input
input:function () {
        var ch = this._input[0];
        this.yytext += ch;
        this.yyleng++;
        this.offset++;
        this.match += ch;
        this.matched += ch;
        var lines = ch.match(/(?:\r\n?|\n).*/g);
        if (lines) {
            this.yylineno++;
            this.yylloc.last_line++;
        } else {
            this.yylloc.last_column++;
        }
        if (this.options.ranges) {
            this.yylloc.range[1]++;
        }

        this._input = this._input.slice(1);
        return ch;
    },

// unshifts one char (or a string) into the input
unput:function (ch) {
        var len = ch.length;
        var lines = ch.split(/(?:\r\n?|\n)/g);

        this._input = ch + this._input;
        this.yytext = this.yytext.substr(0, this.yytext.length - len);
        //this.yyleng -= len;
        this.offset -= len;
        var oldLines = this.match.split(/(?:\r\n?|\n)/g);
        this.match = this.match.substr(0, this.match.length - 1);
        this.matched = this.matched.substr(0, this.matched.length - 1);

        if (lines.length - 1) {
            this.yylineno -= lines.length - 1;
        }
        var r = this.yylloc.range;

        this.yylloc = {
            first_line: this.yylloc.first_line,
            last_line: this.yylineno + 1,
            first_column: this.yylloc.first_column,
            last_column: lines ?
                (lines.length === oldLines.length ? this.yylloc.first_column : 0)
                 + oldLines[oldLines.length - lines.length].length - lines[0].length :
              this.yylloc.first_column - len
        };

        if (this.options.ranges) {
            this.yylloc.range = [r[0], r[0] + this.yyleng - len];
        }
        this.yyleng = this.yytext.length;
        return this;
    },

// When called from action, caches matched text and appends it on next action
more:function () {
        this._more = true;
        return this;
    },

// When called from action, signals the lexer that this rule fails to match the input, so the next matching rule (regex) should be tested instead.
reject:function () {
        if (this.options.backtrack_lexer) {
            this._backtrack = true;
        } else {
            return this.parseError('Lexical error on line ' + (this.yylineno + 1) + '. You can only invoke reject() in the lexer when the lexer is of the backtracking persuasion (options.backtrack_lexer = true).\n' + this.showPosition(), {
                text: "",
                token: null,
                line: this.yylineno
            });

        }
        return this;
    },

// retain first n characters of the match
less:function (n) {
        this.unput(this.match.slice(n));
    },

// displays already matched input, i.e. for error messages
pastInput:function () {
        var past = this.matched.substr(0, this.matched.length - this.match.length);
        return (past.length > 20 ? '...':'') + past.substr(-20).replace(/\n/g, "");
    },

// displays upcoming input, i.e. for error messages
upcomingInput:function () {
        var next = this.match;
        if (next.length < 20) {
            next += this._input.substr(0, 20-next.length);
        }
        return (next.substr(0,20) + (next.length > 20 ? '...' : '')).replace(/\n/g, "");
    },

// displays the character position where the lexing error occurred, i.e. for error messages
showPosition:function () {
        var pre = this.pastInput();
        var c = new Array(pre.length + 1).join("-");
        return pre + this.upcomingInput() + "\n" + c + "^";
    },

// test the lexed token: return FALSE when not a match, otherwise return token
test_match:function (match, indexed_rule) {
        var token,
            lines,
            backup;

        if (this.options.backtrack_lexer) {
            // save context
            backup = {
                yylineno: this.yylineno,
                yylloc: {
                    first_line: this.yylloc.first_line,
                    last_line: this.last_line,
                    first_column: this.yylloc.first_column,
                    last_column: this.yylloc.last_column
                },
                yytext: this.yytext,
                match: this.match,
                matches: this.matches,
                matched: this.matched,
                yyleng: this.yyleng,
                offset: this.offset,
                _more: this._more,
                _input: this._input,
                yy: this.yy,
                conditionStack: this.conditionStack.slice(0),
                done: this.done
            };
            if (this.options.ranges) {
                backup.yylloc.range = this.yylloc.range.slice(0);
            }
        }

        lines = match[0].match(/(?:\r\n?|\n).*/g);
        if (lines) {
            this.yylineno += lines.length;
        }
        this.yylloc = {
            first_line: this.yylloc.last_line,
            last_line: this.yylineno + 1,
            first_column: this.yylloc.last_column,
            last_column: lines ?
                         lines[lines.length - 1].length - lines[lines.length - 1].match(/\r?\n?/)[0].length :
                         this.yylloc.last_column + match[0].length
        };
        this.yytext += match[0];
        this.match += match[0];
        this.matches = match;
        this.yyleng = this.yytext.length;
        if (this.options.ranges) {
            this.yylloc.range = [this.offset, this.offset += this.yyleng];
        }
        this._more = false;
        this._backtrack = false;
        this._input = this._input.slice(match[0].length);
        this.matched += match[0];
        token = this.performAction.call(this, this.yy, this, indexed_rule, this.conditionStack[this.conditionStack.length - 1]);
        if (this.done && this._input) {
            this.done = false;
        }
        if (token) {
            return token;
        } else if (this._backtrack) {
            // recover context
            for (var k in backup) {
                this[k] = backup[k];
            }
            return false; // rule action called reject() implying the next rule should be tested instead.
        }
        return false;
    },

// return next match in input
next:function () {
        if (this.done) {
            return this.EOF;
        }
        if (!this._input) {
            this.done = true;
        }

        var token,
            match,
            tempMatch,
            index;
        if (!this._more) {
            this.yytext = '';
            this.match = '';
        }
        var rules = this._currentRules();
        for (var i = 0; i < rules.length; i++) {
            tempMatch = this._input.match(this.rules[rules[i]]);
            if (tempMatch && (!match || tempMatch[0].length > match[0].length)) {
                match = tempMatch;
                index = i;
                if (this.options.backtrack_lexer) {
                    token = this.test_match(tempMatch, rules[i]);
                    if (token !== false) {
                        return token;
                    } else if (this._backtrack) {
                        match = false;
                        continue; // rule action called reject() implying a rule MISmatch.
                    } else {
                        // else: this is a lexer rule which consumes input without producing a token (e.g. whitespace)
                        return false;
                    }
                } else if (!this.options.flex) {
                    break;
                }
            }
        }
        if (match) {
            token = this.test_match(match, rules[index]);
            if (token !== false) {
                return token;
            }
            // else: this is a lexer rule which consumes input without producing a token (e.g. whitespace)
            return false;
        }
        if (this._input === "") {
            return this.EOF;
        } else {
            return this.parseError('Lexical error on line ' + (this.yylineno + 1) + '. Unrecognized text.\n' + this.showPosition(), {
                text: "",
                token: null,
                line: this.yylineno
            });
        }
    },

// return next match that has a token
lex:function lex() {
        var r = this.next();
        if (r) {
            return r;
        } else {
            return this.lex();
        }
    },

// activates a new lexer condition state (pushes the new lexer condition state onto the condition stack)
begin:function begin(condition) {
        this.conditionStack.push(condition);
    },

// pop the previously active lexer condition state off the condition stack
popState:function popState() {
        var n = this.conditionStack.length - 1;
        if (n > 0) {
            return this.conditionStack.pop();
        } else {
            return this.conditionStack[0];
        }
    },

// produce the lexer rule set which is active for the currently active lexer condition state
_currentRules:function _currentRules() {
        if (this.conditionStack.length && this.conditionStack[this.conditionStack.length - 1]) {
            return this.conditions[this.conditionStack[this.conditionStack.length - 1]].rules;
        } else {
            return this.conditions["INITIAL"].rules;
        }
    },

// return the currently active lexer condition state; when an index argument is provided it produces the N-th previous condition state, if available
topState:function topState(n) {
        n = this.conditionStack.length - 1 - Math.abs(n || 0);
        if (n >= 0) {
            return this.conditionStack[n];
        } else {
            return "INITIAL";
        }
    },

// alias for begin(condition)
pushState:function pushState(condition) {
        this.begin(condition);
    },

// return the number of states currently on the stack
stateStackSize:function stateStackSize() {
        return this.conditionStack.length;
    },
options: {"case-insensitive":true,"flex":true},
performAction: function anonymous(yy,yy_,$avoiding_name_collisions,YY_START) {
var YYSTATE=YY_START;
switch($avoiding_name_collisions) {
case 0: /* skip whitespace */ 
break;
case 1: /* skip comments */ 
break;
case 2: /* skip comments */ 
break;
case 3: parser.yy.partialCursor = false; parser.yy.cursorFound = yy_.yylloc; return 19; 
break;
case 4: parser.yy.partialCursor = true; parser.yy.cursorFound = yy_.yylloc; return 441; 
break;
case 5: return 166; 
break;
case 6: return 285; 
break;
case 7: return 167; 
break;
case 8: return 164; 
break;
case 9: return 168; 
break;
case 10: return 169; 
break;
case 11: return 860; 
break;
case 12: return 171; 
break;
case 13: return 172; 
break;
case 14: parser.determineCase(yy_.yytext); return 439; 
break;
case 15: return 173; 
break;
case 16: return 174; 
break;
case 17: return 175; 
break;
case 18: parser.determineCase(yy_.yytext); return 1166; 
break;
case 19: parser.determineCase(yy_.yytext); return 570; 
break;
case 20: return 165; 
break;
case 21: return 178; 
break;
case 22: return 179; 
break;
case 23: return 180; 
break;
case 24: return 181; 
break;
case 25: return 182; 
break;
case 26: return 183; 
break;
case 27: parser.determineCase(yy_.yytext); return 1253; 
break;
case 28: parser.determineCase(yy_.yytext); return 1190; 
break;
case 29: return 184; 
break;
case 30: return 185; 
break;
case 31: return 187; 
break;
case 32: return 321; 
break;
case 33: return 198; 
break;
case 34: return 199; 
break;
case 35: return 200; 
break;
case 36: return 189; 
break;
case 37: return 190; 
break;
case 38: return 1193; 
break;
case 39: return 191; 
break;
case 40: return 193; 
break;
case 41: return 125; 
break;
case 42: return 132; 
break;
case 43: return 204; 
break;
case 44: return 205; 
break;
case 45: return 957; 
break;
case 46: parser.determineCase(yy_.yytext); return 26; 
break;
case 47: return 27; 
break;
case 48: return 28; 
break;
case 49: return 29; 
break;
case 50: parser.determineCase(yy_.yytext); return 30; 
break;
case 51: return 31; 
break;
case 52: return 194; 
break;
case 53: return 32; 
break;
case 54: return 33; 
break;
case 55: return 34; 
break;
case 56: return 35; 
break;
case 57: return 36; 
break;
case 58: return 170; 
break;
case 59: return 37; 
break;
case 60: return 38; 
break;
case 61: return 39; 
break;
case 62: return 40; 
break;
case 63: return 41; 
break;
case 64: return 42; 
break;
case 65: return 43; 
break;
case 66: return 44; 
break;
case 67: return 45; 
break;
case 68: return 46; 
break;
case 69: return 135; 
break;
case 70: return 369; 
break;
case 71: return 47; 
break;
case 72: return 48; 
break;
case 73: return 49; 
break;
case 74: return 50; 
break;
case 75: return 51; 
break;
case 76: return 571; 
break;
case 77: this.begin('hdfs'); return 52; 
break;
case 78: return 53; 
break;
case 79: return 176; 
break;
case 80: return 54; 
break;
case 81: return 56; 
break;
case 82: return 55; 
break;
case 83: return 57; 
break;
case 84: parser.determineCase(yy_.yytext); return 58; 
break;
case 85: parser.determineCase(yy_.yytext); return 59; 
break;
case 86: return 60; 
break;
case 87: return 61; 
break;
case 88: return 62; 
break;
case 89: return 63; 
break;
case 90: return 64; 
break;
case 91: return 195; 
break;
case 92: return 181; 
break;
case 93: return 65; 
break;
case 94: return 136; 
break;
case 95: return 69; 
break;
case 96: return 196; 
break;
case 97: return 197; 
break;
case 98: this.begin('hdfs'); return 66; 
break;
case 99: return 67; 
break;
case 100: return 70; 
break;
case 101: return 68; 
break;
case 102: return 71; 
break;
case 103: return 72; 
break;
case 104: return 73; 
break;
case 105: parser.determineCase(yy_.yytext); return 74; 
break;
case 106: this.begin('hdfs'); return 75; 
break;
case 107: return 186; 
break;
case 108: return 76; 
break;
case 109: return 77; 
break;
case 110: return 79; 
break;
case 111: return 78; 
break;
case 112: return 137; 
break;
case 113: return 138; 
break;
case 114: return 80; 
break;
case 115: return 99; 
break;
case 116: return 81; 
break;
case 117: return 82; 
break;
case 118: return 83; 
break;
case 119: return 84; 
break;
case 120: return 85; 
break;
case 121: return 86; 
break;
case 122: return 87; 
break;
case 123: this.begin('hdfs'); return 1207; 
break;
case 124: return 88; 
break;
case 125: return 89; 
break;
case 126: return 90; 
break;
case 127: return 91; 
break;
case 128: return 92; 
break;
case 129: return 93; 
break;
case 130: return 94; 
break;
case 131: return 139; 
break;
case 132: return 95; 
break;
case 133: return 96; 
break;
case 134: parser.determineCase(yy_.yytext); return 97; 
break;
case 135: return 98; 
break;
case 136: return 100; 
break;
case 137: return 101; 
break;
case 138: return 102; 
break;
case 139: return 103; 
break;
case 140: return 104; 
break;
case 141: return 105; 
break;
case 142: return 106; 
break;
case 143: return 107; 
break;
case 144: return 140; 
break;
case 145: return 201; 
break;
case 146: return 108; 
break;
case 147: return 109; 
break;
case 148: return 110; 
break;
case 149: return 111; 
break;
case 150: return 112; 
break;
case 151: parser.determineCase(yy_.yytext); return 113; 
break;
case 152: return 192; 
break;
case 153: return 114; 
break;
case 154: return 857; 
break;
case 155: return 656; 
break;
case 156: return 115; 
break;
case 157: return 116; 
break;
case 158: return 117; 
break;
case 159: return 202; 
break;
case 160: return 118; 
break;
case 161: return 119; 
break;
case 162: return 120; 
break;
case 163: return 203; 
break;
case 164: return 121; 
break;
case 165: return 122; 
break;
case 166: return 123; 
break;
case 167: return 124; 
break;
case 168: return 126; 
break;
case 169: return 127; 
break;
case 170: return 128; 
break;
case 171: return 129; 
break;
case 172: return 130; 
break;
case 173: parser.determineCase(yy_.yytext); return 131; 
break;
case 174: return 133; 
break;
case 175: return 134; 
break;
case 176: return 141; 
break;
case 177: return 206; 
break;
case 178: return 142; 
break;
case 179: return 207; 
break;
case 180: return 208; 
break;
case 181: return 209; 
break;
case 182: return 908; 
break;
case 183: return 210; 
break;
case 184: return 211; 
break;
case 185: return 212; 
break;
case 186: return 213; 
break;
case 187: return 906; 
break;
case 188: return 214; 
break;
case 189: return 215; 
break;
case 190: return 898; 
break;
case 191: parser.determineCase(yy_.yytext); return 452; 
break;
case 192: parser.determineCase(yy_.yytext); return 933; 
break;
case 193: parser.determineCase(yy_.yytext); parser.addStatementTypeLocation('CREATE', yy_.yylloc, yy.lexer.upcomingInput()); return 440; 
break;
case 194: return 216; 
break;
case 195: return 217; 
break;
case 196: return 218; 
break;
case 197: return 219; 
break;
case 198: parser.determineCase(yy_.yytext); parser.addStatementTypeLocation('DESCRIBE', yy_.yylloc); return 569; 
break;
case 199: return 220; 
break;
case 200: parser.determineCase(yy_.yytext); parser.addStatementTypeLocation('EXPLAIN', yy_.yylloc); return 163; 
break;
case 201: return 222; 
break;
case 202: return 221; 
break;
case 203: return 223; 
break;
case 204: return 907; 
break;
case 205: return 224; 
break;
case 206: return 225; 
break;
case 207: return 226; 
break;
case 208: return 227; 
break;
case 209: return 228; 
break;
case 210: return 229; 
break;
case 211: return 230; 
break;
case 212: return 231; 
break;
case 213: return 232; 
break;
case 214: return 233; 
break;
case 215: return 234; 
break;
case 216: parser.determineCase(yy_.yytext); parser.addStatementTypeLocation('INSERT', yy_.yylloc); return 1192; 
break;
case 217: return 236; 
break;
case 218: return 235; 
break;
case 219: return 237; 
break;
case 220: parser.determineCase(yy_.yytext); parser.addStatementTypeLocation('INVALIDATE', yy_.yylloc, yy.lexer.upcomingInput()); return 931; 
break;
case 221: this.begin('hdfs'); return 238; 
break;
case 222: return 239; 
break;
case 223: return 156; 
break;
case 224: return 240; 
break;
case 225: return 241; 
break;
case 226: this.begin('hdfs'); return 975; 
break;
case 227: return 242; 
break;
case 228: return 243; 
break;
case 229: parser.determineCase(yy_.yytext); parser.addStatementTypeLocation('LOAD', yy_.yylloc, yy.lexer.upcomingInput()); return 1252; 
break;
case 230: this.begin('hdfs'); return 244; 
break;
case 231: return 245; 
break;
case 232: return 932; 
break;
case 233: return 246; 
break;
case 234: return 663; 
break;
case 235: return 1040; 
break;
case 236: return 1230; 
break;
case 237: return 268; 
break;
case 238: return 269; 
break;
case 239: return 247; 
break;
case 240: return 248; 
break;
case 241: return 249; 
break;
case 242: return 270; 
break;
case 243: return 250; 
break;
case 244: return 251; 
break;
case 245: parser.determineCase(yy_.yytext); parser.addStatementTypeLocation('REFRESH', yy_.yylloc); return 930; 
break;
case 246: return 910; 
break;
case 247: return 252; 
break;
case 248: return 762; 
break;
case 249: return 253; 
break;
case 250: return 254; 
break;
case 251: return 255; 
break;
case 252: parser.determineCase(yy_.yytext); parser.addStatementTypeLocation('REVOKE', yy_.yylloc); return 1195; 
break;
case 253: return 271; 
break;
case 254: return 272; 
break;
case 255: return 256; 
break;
case 256: return 257; 
break;
case 257: return 150; 
break;
case 258: return 258; 
break;
case 259: return 259; 
break;
case 260: return 274; 
break;
case 261: return 260; 
break;
case 262: return 261; 
break;
case 263: return 262; 
break;
case 264: return 263; 
break;
case 265: return 264; 
break;
case 266: return 275; 
break;
case 267: return 276; 
break;
case 268: return 277; 
break;
case 269: return 543; 
break;
case 270: return 278; 
break;
case 271: parser.determineCase(yy_.yytext); parser.addStatementTypeLocation('UPSERT', yy_.yylloc); return 1227; 
break;
case 272: return 149; 
break;
case 273: return 265; 
break;
case 274: return 833; 
break;
case 275: return 143; 
break;
case 276: return 266; 
break;
case 277: return 285; 
break;
case 278: return 152; 
break;
case 279: return 153; 
break;
case 280: return 144; 
break;
case 281: return 154; 
break;
case 282: return 155; 
break;
case 283: return 145; 
break;
case 284: return 321; 
break;
case 285: return 146; 
break;
case 286: return 147; 
break;
case 287: return 148; 
break;
case 288: return 119; 
break;
case 289: return 151; 
break;
case 290: return 279; 
break;
case 291: return 267; 
break;
case 292: return 273; 
break;
case 293: return 280; 
break;
case 294: return 281; 
break;
case 295: return 282; 
break;
case 296: return 283; 
break;
case 297: this.popState(); return 668; 
break;
case 298: return 284; 
break;
case 299: parser.determineCase(yy_.yytext); parser.addStatementTypeLocation('ALTER', yy_.yylloc, yy.lexer.upcomingInput()); return 826; 
break;
case 300: return 385; 
break;
case 301: return 286; 
break;
case 302: return 287; 
break;
case 303: this.begin('between'); return 288; 
break;
case 304: return 289; 
break;
case 305: return 290; 
break;
case 306: return 291; 
break;
case 307: return 292; 
break;
case 308: return 293; 
break;
case 309: parser.determineCase(yy_.yytext); return 438; 
break;
case 310: return 294; 
break;
case 311: return 295; 
break;
case 312: return 296; 
break;
case 313: return 297; 
break;
case 314: return 298; 
break;
case 315: return 393; 
break;
case 316: return 299; 
break;
case 317: return 300; 
break;
case 318: parser.determineCase(yy_.yytext); parser.addStatementTypeLocation('DROP', yy_.yylloc, yy.lexer.upcomingInput()); return 868; 
break;
case 319: return 301; 
break;
case 320: return 302; 
break;
case 321: parser.yy.correlatedSubQuery = true; return 303; 
break;
case 322: return 304; 
break;
case 323: return 305; 
break;
case 324: return 306; 
break;
case 325: parser.determineCase(yy_.yytext); return 307; 
break;
case 326: return 308; 
break;
case 327: return 309; 
break;
case 328: return 310; 
break;
case 329: return 311; 
break;
case 330: return 312; 
break;
case 331: return 313; 
break;
case 332: return 1213; 
break;
case 333: return 314; 
break;
case 334: return 315; 
break;
case 335: return 316; 
break;
case 336: return 317; 
break;
case 337: return 318; 
break;
case 338: return 319; 
break;
case 339: return 320; 
break;
case 340: return 322; 
break;
case 341: return 323; 
break;
case 342: return 324; 
break;
case 343: return 158; 
break;
case 344: return 386; 
break;
case 345: return 325; 
break;
case 346: return 326; 
break;
case 347: return 328; 
break;
case 348: return 329; 
break;
case 349: return 330; 
break;
case 350: return 331; 
break;
case 351: return 332; 
break;
case 352: return 333; 
break;
case 353: return 334; 
break;
case 354: return 335; 
break;
case 355: return 336; 
break;
case 356: return 337; 
break;
case 357: parser.determineCase(yy_.yytext); parser.addStatementTypeLocation('SELECT', yy_.yylloc); return 577; 
break;
case 358: return 338; 
break;
case 359: parser.determineCase(yy_.yytext); parser.addStatementTypeLocation('SET', yy_.yylloc); return 339; 
break;
case 360: parser.determineCase(yy_.yytext); parser.addStatementTypeLocation('SHOW', yy_.yylloc); return 1278; 
break;
case 361: return 340; 
break;
case 362: return 341; 
break;
case 363: return 342; 
break;
case 364: return 343; 
break;
case 365: return 344; 
break;
case 366: return 345; 
break;
case 367: return 837; 
break;
case 368: return 346; 
break;
case 369: parser.determineCase(yy_.yytext); parser.addStatementTypeLocation('TRUNCATE', yy_.yylloc, yy.lexer.upcomingInput()); return 763; 
break;
case 370: return 785; 
break;
case 371: parser.determineCase(yy_.yytext); return 1191; 
break;
case 372: parser.determineCase(yy_.yytext); parser.addStatementTypeLocation('USE', yy_.yylloc); return 1314; 
break;
case 373: return 347; 
break;
case 374: return 1101; 
break;
case 375: return 349; 
break;
case 376: return 348; 
break;
case 377: return 350; 
break;
case 378: return 351; 
break;
case 379: parser.determineCase(yy_.yytext); parser.addStatementTypeLocation('WITH', yy_.yylloc); return 352; 
break;
case 380: return 327; 
break;
case 381: return 157; 
break;
case 382: yy.lexer.unput('('); yy_.yytext = 'avg'; parser.addFunctionLocation(yy_.yylloc, yy_.yytext); return 353; 
break;
case 383: yy.lexer.unput('('); yy_.yytext = 'cast'; parser.addFunctionLocation(yy_.yylloc, yy_.yytext); return 354; 
break;
case 384: yy.lexer.unput('('); yy_.yytext = 'count'; parser.addFunctionLocation(yy_.yylloc, yy_.yytext); return 355; 
break;
case 385: yy.lexer.unput('('); yy_.yytext = 'max'; parser.addFunctionLocation(yy_.yylloc, yy_.yytext); return 356; 
break;
case 386: yy.lexer.unput('('); yy_.yytext = 'min'; parser.addFunctionLocation(yy_.yylloc, yy_.yytext); return 357; 
break;
case 387: yy.lexer.unput('('); yy_.yytext = 'stddev_pop'; parser.addFunctionLocation(yy_.yylloc, yy_.yytext); return 358; 
break;
case 388: yy.lexer.unput('('); yy_.yytext = 'stddev_samp'; parser.addFunctionLocation(yy_.yylloc, yy_.yytext); return 359; 
break;
case 389: yy.lexer.unput('('); yy_.yytext = 'sum'; parser.addFunctionLocation(yy_.yylloc, yy_.yytext); return 360; 
break;
case 390: yy.lexer.unput('('); yy_.yytext = 'variance'; parser.addFunctionLocation(yy_.yylloc, yy_.yytext); return 361; 
break;
case 391: yy.lexer.unput('('); yy_.yytext = 'var_pop'; parser.addFunctionLocation(yy_.yylloc, yy_.yytext); return 362; 
break;
case 392: yy.lexer.unput('('); yy_.yytext = 'var_samp'; parser.addFunctionLocation(yy_.yylloc, yy_.yytext); return 363; 
break;
case 393: yy.lexer.unput('('); yy_.yytext = 'collect_set'; parser.addFunctionLocation(yy_.yylloc, yy_.yytext); return 364; 
break;
case 394: yy.lexer.unput('('); yy_.yytext = 'collect_list'; parser.addFunctionLocation(yy_.yylloc, yy_.yytext); return 365; 
break;
case 395: yy.lexer.unput('('); yy_.yytext = 'corr'; parser.addFunctionLocation(yy_.yylloc, yy_.yytext); return 366; 
break;
case 396: yy.lexer.unput('('); yy_.yytext = 'covar_pop'; parser.addFunctionLocation(yy_.yylloc, yy_.yytext); return 367; 
break;
case 397: yy.lexer.unput('('); yy_.yytext = 'covar_samp'; parser.addFunctionLocation(yy_.yylloc, yy_.yytext); return 368; 
break;
case 398: yy.lexer.unput('('); yy_.yytext = 'extract'; parser.addFunctionLocation(yy_.yylloc, yy_.yytext); return 794; 
break;
case 399: yy.lexer.unput('('); yy_.yytext = 'histogram_numeric'; parser.addFunctionLocation(yy_.yylloc, yy_.yytext); return 370; 
break;
case 400: yy.lexer.unput('('); yy_.yytext = 'ntile'; parser.addFunctionLocation(yy_.yylloc, yy_.yytext); return 371; 
break;
case 401: yy.lexer.unput('('); yy_.yytext = 'percentile'; parser.addFunctionLocation(yy_.yylloc, yy_.yytext); return 372; 
break;
case 402: yy.lexer.unput('('); yy_.yytext = 'percentile_approx'; parser.addFunctionLocation(yy_.yylloc, yy_.yytext); return 373; 
break;
case 403: yy.lexer.unput('('); yy_.yytext = 'appx_median'; parser.addFunctionLocation(yy_.yylloc, yy_.yytext); return 374; 
break;
case 404: yy.lexer.unput('('); yy_.yytext = 'extract'; parser.addFunctionLocation(yy_.yylloc, yy_.yytext); return 375; 
break;
case 405: yy.lexer.unput('('); yy_.yytext = 'group_concat'; parser.addFunctionLocation(yy_.yylloc, yy_.yytext); return 376; 
break;
case 406: yy.lexer.unput('('); yy_.yytext = 'ndv'; parser.addFunctionLocation(yy_.yylloc, yy_.yytext); return 377; 
break;
case 407: yy.lexer.unput('('); yy_.yytext = 'stddev'; parser.addFunctionLocation(yy_.yylloc, yy_.yytext); return 378; 
break;
case 408: yy.lexer.unput('('); yy_.yytext = 'variance_pop'; parser.addFunctionLocation(yy_.yylloc, yy_.yytext); return 379; 
break;
case 409: yy.lexer.unput('('); yy_.yytext = 'variance_samp'; parser.addFunctionLocation(yy_.yylloc, yy_.yytext); return 380; 
break;
case 410: yy.lexer.unput('('); yy_.yytext = 'cume_dist'; parser.addFunctionLocation(yy_.yylloc, yy_.yytext); return 381; 
break;
case 411: yy.lexer.unput('('); yy_.yytext = 'dense_rank'; parser.addFunctionLocation(yy_.yylloc, yy_.yytext); return 381; 
break;
case 412: yy.lexer.unput('('); yy_.yytext = 'first_value'; parser.addFunctionLocation(yy_.yylloc, yy_.yytext); return 381; 
break;
case 413: yy.lexer.unput('('); yy_.yytext = 'lag'; parser.addFunctionLocation(yy_.yylloc, yy_.yytext); return 381; 
break;
case 414: yy.lexer.unput('('); yy_.yytext = 'last_value'; parser.addFunctionLocation(yy_.yylloc, yy_.yytext); return 381; 
break;
case 415: yy.lexer.unput('('); yy_.yytext = 'lead'; parser.addFunctionLocation(yy_.yylloc, yy_.yytext); return 381; 
break;
case 416: yy.lexer.unput('('); yy_.yytext = 'rank'; parser.addFunctionLocation(yy_.yylloc, yy_.yytext); return 381; 
break;
case 417: yy.lexer.unput('('); yy_.yytext = 'row_number'; parser.addFunctionLocation(yy_.yylloc, yy_.yytext); return 381; 
break;
case 418: yy.lexer.unput('('); yy_.yytext = 'cume_dist'; parser.addFunctionLocation(yy_.yylloc, yy_.yytext); return 381; 
break;
case 419: yy.lexer.unput('('); yy_.yytext = 'percent_rank'; parser.addFunctionLocation(yy_.yylloc, yy_.yytext); return 381; 
break;
case 420: yy.lexer.unput('('); yy_.yytext = 'ntile'; parser.addFunctionLocation(yy_.yylloc, yy_.yytext); return 381; 
break;
case 421: yy.lexer.unput('('); yy_.yytext = 'percent_rank'; parser.addFunctionLocation(yy_.yylloc, yy_.yytext); return 381; 
break;
case 422: yy.lexer.unput('('); yy_.yytext = 'system'; return 727; 
break;
case 423: return 382; 
break;
case 424: return 382; 
break;
case 425: return 383; 
break;
case 426: return 160; 
break;
case 427: parser.yy.cursorFound = true; return 19; 
break;
case 428: parser.yy.cursorFound = true; return 441; 
break;
case 429: return 384; 
break;
case 430: parser.addFileLocation(yy_.yylloc, yy_.yytext); return 789; 
break;
case 431: this.popState(); return 790; 
break;
case 432: return 6; 
break;
case 433: return 385; 
break;
case 434: return 386; 
break;
case 435: return 387; 
break;
case 436: return 388; 
break;
case 437: return 389; 
break;
case 438: return 390; 
break;
case 439: return 390; 
break;
case 440: return 390; 
break;
case 441: return 390; 
break;
case 442: return 390; 
break;
case 443: return 391; 
break;
case 444: return 392; 
break;
case 445: return 393; 
break;
case 446: return 393; 
break;
case 447: return 393; 
break;
case 448: return 393; 
break;
case 449: return 393; 
break;
case 450: return 393; 
break;
case 451: return 394; 
break;
case 452: return 395; 
break;
case 453: return 1006; 
break;
case 454: return 10; 
break;
case 455: return 396; 
break;
case 456: return 397; 
break;
case 457: return 398; 
break;
case 458: return 399; 
break;
case 459: return 400; 
break;
case 460: return 401; 
break;
case 461: return 161; 
break;
case 462: this.begin('backtickedValue'); return 402; 
break;
case 463:
                                             if (parser.handleQuotedValueWithCursor(this, yy_.yytext, yy_.yylloc, '`')) {
                                               return 471;
                                             }
                                             return 469;
                                           
break;
case 464: this.popState(); return 402; 
break;
case 465: this.begin('singleQuotedValue'); return 403; 
break;
case 466:
                                             if (parser.handleQuotedValueWithCursor(this, yy_.yytext, yy_.yylloc, '\'')) {
                                               return 471;
                                             }
                                             return 469;
                                           
break;
case 467: this.popState(); return 403; 
break;
case 468: this.begin('doubleQuotedValue'); return 404; 
break;
case 469:
                                             if (parser.handleQuotedValueWithCursor(this, yy_.yytext, yy_.yylloc, '"')) {
                                               return 471;
                                             }
                                             return 469;
                                           
break;
case 470: this.popState(); return 404; 
break;
case 471: return 6; 
break;
case 472: /* To prevent console logging of unknown chars */ 
break;
case 473: 
break;
case 474: 
break;
case 475: 
break;
case 476: 
break;
case 477: 
break;
case 478: 
break;
case 479: 
break;
case 480:console.log(yy_.yytext);
break;
}
},
rules: [/^(?:\s)/i,/^(?:--.*)/i,/^(?:[\/][*][^*]*[*]+([^\/*][^*]*[*]+)*[\/])/i,/^(?:\u2020)/i,/^(?:\u2021)/i,/^(?:ALL)/i,/^(?:ARRAY)/i,/^(?:AS)/i,/^(?:AUTHORIZATION)/i,/^(?:BINARY)/i,/^(?:CACHE)/i,/^(?:COLUMN)/i,/^(?:CONF)/i,/^(?:CONSTRAINT)/i,/^(?:CREATE)/i,/^(?:CUBE)/i,/^(?:CURRENT)/i,/^(?:DATE)/i,/^(?:DELETE)/i,/^(?:DESCRIBE)/i,/^(?:EXTENDED)/i,/^(?:EXTERNAL)/i,/^(?:FOR)/i,/^(?:FOREIGN)/i,/^(?:FUNCTION)/i,/^(?:GRANT)/i,/^(?:GROUPING)/i,/^(?:IMPORT)/i,/^(?:INSERT)/i,/^(?:LATERAL)/i,/^(?:LOCAL)/i,/^(?:MACRO)/i,/^(?:MAP)/i,/^(?:NONE)/i,/^(?:OF)/i,/^(?:OUT)/i,/^(?:PRIMARY)/i,/^(?:REFERENCES)/i,/^(?:REVOKE)/i,/^(?:ROLLUP)/i,/^(?:TABLE)/i,/^(?:TIMESTAMP)/i,/^(?:USER)/i,/^(?:USING)/i,/^(?:VIEWS)/i,/^(?:LIFECYCLE)/i,/^(?:ABORT)/i,/^(?:ADD)/i,/^(?:ADMIN)/i,/^(?:AFTER)/i,/^(?:ANALYZE)/i,/^(?:ARCHIVE)/i,/^(?:ASC)/i,/^(?:AVRO)/i,/^(?:BUCKET)/i,/^(?:BUCKETS)/i,/^(?:CASCADE)/i,/^(?:CHANGE)/i,/^(?:CLUSTER)/i,/^(?:CLUSTERED)/i,/^(?:COLLECTION)/i,/^(?:COLUMNS)/i,/^(?:COMMENT)/i,/^(?:COMPACT)/i,/^(?:COMPACTIONS)/i,/^(?:COMPUTE)/i,/^(?:CONCATENATE)/i,/^(?:DATA)/i,/^(?:DATABASES)/i,/^(?:DAY)/i,/^(?:DAYOFWEEK)/i,/^(?:DBPROPERTIES)/i,/^(?:DEFERRED)/i,/^(?:DEFINED)/i,/^(?:DELIMITED)/i,/^(?:DEPENDENCY)/i,/^(?:DESC)/i,/^(?:DIRECTORY)/i,/^(?:DISABLE)/i,/^(?:DISTRIBUTE)/i,/^(?:DOUBLE\s+PRECISION)/i,/^(?:ESCAPED)/i,/^(?:ENABLE)/i,/^(?:EXCHANGE)/i,/^(?:EXPLAIN)/i,/^(?:EXPORT)/i,/^(?:FIELDS)/i,/^(?:FILE)/i,/^(?:FILEFORMAT)/i,/^(?:FIRST)/i,/^(?:FORMAT)/i,/^(?:FORMATTED)/i,/^(?:FUNCTION)/i,/^(?:FUNCTIONS)/i,/^(?:HOUR)/i,/^(?:IDXPROPERTIES)/i,/^(?:INDEX)/i,/^(?:INDEXES)/i,/^(?:INPATH)/i,/^(?:INPUTFORMAT)/i,/^(?:ITEMS)/i,/^(?:JAR)/i,/^(?:KEY)/i,/^(?:KEYS)/i,/^(?:LINES)/i,/^(?:LOAD)/i,/^(?:LOCATION)/i,/^(?:LOCK)/i,/^(?:LOCKS)/i,/^(?:MATCHED)/i,/^(?:MERGE)/i,/^(?:METADATA)/i,/^(?:MINUTE)/i,/^(?:MONTH)/i,/^(?:MSCK)/i,/^(?:NORELY)/i,/^(?:NOSCAN)/i,/^(?:NOVALIDATE)/i,/^(?:NO_DROP)/i,/^(?:OFFLINE)/i,/^(?:ORC)/i,/^(?:OUTPUTFORMAT)/i,/^(?:OVERWRITE)/i,/^(?:OVERWRITE\s+DIRECTORY)/i,/^(?:OWNER)/i,/^(?:PARQUET)/i,/^(?:PARTITIONED)/i,/^(?:PARTITIONS)/i,/^(?:PERCENT)/i,/^(?:PRIVILEGES)/i,/^(?:PURGE)/i,/^(?:QUARTER)/i,/^(?:RCFILE)/i,/^(?:REBUILD)/i,/^(?:RELOAD)/i,/^(?:RELY)/i,/^(?:REPAIR)/i,/^(?:REPLICATION)/i,/^(?:RECOVER)/i,/^(?:RENAME)/i,/^(?:REPLACE)/i,/^(?:RESTRICT)/i,/^(?:ROLE)/i,/^(?:ROLES)/i,/^(?:SECOND)/i,/^(?:SCHEMA)/i,/^(?:SCHEMAS)/i,/^(?:SEQUENCEFILE)/i,/^(?:SERDE)/i,/^(?:SERDEPROPERTIES)/i,/^(?:SETS)/i,/^(?:SHOW)/i,/^(?:SHOW_DATABASE)/i,/^(?:SKEWED)/i,/^(?:SKEWED LOCATION)/i,/^(?:SORT)/i,/^(?:SORTED)/i,/^(?:STATISTICS)/i,/^(?:STORED)/i,/^(?:STORED\s+AS\s+DIRECTORIES)/i,/^(?:STRING)/i,/^(?:STRUCT)/i,/^(?:TABLES)/i,/^(?:TABLESAMPLE)/i,/^(?:TBLPROPERTIES)/i,/^(?:TEMPORARY)/i,/^(?:TERMINATED)/i,/^(?:TEXTFILE)/i,/^(?:TINYINT)/i,/^(?:TOUCH)/i,/^(?:TRANSACTIONS)/i,/^(?:UNARCHIVE)/i,/^(?:UNIONTYPE)/i,/^(?:USE)/i,/^(?:VIEW)/i,/^(?:WAIT)/i,/^(?:WEEK)/i,/^(?:WINDOW)/i,/^(?:YEAR)/i,/^(?:\.)/i,/^(?:\[)/i,/^(?:\])/i,/^(?:ADD)/i,/^(?:AGGREGATE)/i,/^(?:AVRO)/i,/^(?:CACHED)/i,/^(?:CASCADE)/i,/^(?:CHANGE)/i,/^(?:CLOSE_FN)/i,/^(?:COLUMN)/i,/^(?:COLUMNS)/i,/^(?:COMMENT)/i,/^(?:COMPUTE)/i,/^(?:CREATE)/i,/^(?:DATA)/i,/^(?:DATABASES)/i,/^(?:DELETE)/i,/^(?:DELIMITED)/i,/^(?:DESCRIBE)/i,/^(?:ESCAPED)/i,/^(?:EXPLAIN)/i,/^(?:EXTERNAL)/i,/^(?:EXTENDED)/i,/^(?:FIELDS)/i,/^(?:FILEFORMAT)/i,/^(?:FILES)/i,/^(?:FINALIZE_FN)/i,/^(?:FIRST)/i,/^(?:FORMAT)/i,/^(?:FORMATTED)/i,/^(?:FUNCTION)/i,/^(?:FUNCTIONS)/i,/^(?:GROUP)/i,/^(?:HASH)/i,/^(?:ILIKE)/i,/^(?:INCREMENTAL)/i,/^(?:INSERT)/i,/^(?:INTERVAL)/i,/^(?:INTERMEDIATE)/i,/^(?:INIT_FN)/i,/^(?:INVALIDATE)/i,/^(?:INPATH)/i,/^(?:IREGEXP)/i,/^(?:KEY)/i,/^(?:KUDU)/i,/^(?:LAST)/i,/^(?:LIKE\s+PARQUET)/i,/^(?:LIMIT)/i,/^(?:LINES)/i,/^(?:LOAD)/i,/^(?:LOCATION)/i,/^(?:MERGE_FN)/i,/^(?:METADATA)/i,/^(?:NULLS)/i,/^(?:OFFSET)/i,/^(?:ORC)/i,/^(?:OVERWRITE)/i,/^(?:PARQUET)/i,/^(?:PARTITIONED)/i,/^(?:PARTITIONS)/i,/^(?:PREPARE_FN)/i,/^(?:PRIMARY)/i,/^(?:RCFILE)/i,/^(?:RANGE)/i,/^(?:REAL)/i,/^(?:REFRESH)/i,/^(?:RENAME)/i,/^(?:REPEATABLE)/i,/^(?:REPLACE)/i,/^(?:REPLICATION)/i,/^(?:RESTRICT)/i,/^(?:RETURNS)/i,/^(?:REVOKE)/i,/^(?:SEQUENCEFILE)/i,/^(?:SERDEPROPERTIES)/i,/^(?:SCHEMAS)/i,/^(?:SERIALIZE_FN)/i,/^(?:SERVER)/i,/^(?:SORT)/i,/^(?:STATS)/i,/^(?:STORED)/i,/^(?:STRAIGHT_JOIN)/i,/^(?:SYMBOL)/i,/^(?:TABLE)/i,/^(?:TABLES)/i,/^(?:TABLESAMPLE)/i,/^(?:TBLPROPERTIES)/i,/^(?:TERMINATED)/i,/^(?:TEXTFILE)/i,/^(?:UNCACHED)/i,/^(?:UPDATE_FN)/i,/^(?:UPSERT)/i,/^(?:URI)/i,/^(?:USING)/i,/^(?:PARTITION\s+VALUE\s)/i,/^(?:ANALYTIC)/i,/^(?:ANTI)/i,/^(?:ARRAY)/i,/^(?:BLOCK_SIZE)/i,/^(?:COMPRESSION)/i,/^(?:CURRENT)/i,/^(?:DEFAULT)/i,/^(?:ENCODING)/i,/^(?:GRANT)/i,/^(?:MAP)/i,/^(?:RECOVER)/i,/^(?:ROLE)/i,/^(?:ROLES)/i,/^(?:STRUCT)/i,/^(?:UNKNOWN)/i,/^(?:\[BROADCAST\])/i,/^(?:\[NOSHUFFLE\])/i,/^(?:\[SHUFFLE\])/i,/^(?:\.\.\.)/i,/^(?:\.)/i,/^(?:\[)/i,/^(?:\])/i,/^(?:AND)/i,/^(?:ALL)/i,/^(?:ALTER)/i,/^(?:AND)/i,/^(?:AS)/i,/^(?:ASC)/i,/^(?:BETWEEN)/i,/^(?:BIGINT)/i,/^(?:BOOLEAN)/i,/^(?:BY)/i,/^(?:CASE)/i,/^(?:CHAR)/i,/^(?:CREATE)/i,/^(?:CROSS)/i,/^(?:CURRENT)/i,/^(?:DATABASE)/i,/^(?:DECIMAL)/i,/^(?:DISTINCT)/i,/^(?:DIV)/i,/^(?:DOUBLE)/i,/^(?:DESC)/i,/^(?:DROP)/i,/^(?:ELSE)/i,/^(?:END)/i,/^(?:EXISTS)/i,/^(?:FALSE)/i,/^(?:FLOAT)/i,/^(?:FOLLOWING)/i,/^(?:FROM)/i,/^(?:FULL)/i,/^(?:GROUP)/i,/^(?:HAVING)/i,/^(?:IF)/i,/^(?:IN)/i,/^(?:INNER)/i,/^(?:INSERT)/i,/^(?:INT)/i,/^(?:INTO)/i,/^(?:IS)/i,/^(?:JOIN)/i,/^(?:LEFT)/i,/^(?:LIKE)/i,/^(?:LIMIT)/i,/^(?:NOT)/i,/^(?:NULL)/i,/^(?:ON)/i,/^(?:OPTION)/i,/^(?:OR)/i,/^(?:ORDER)/i,/^(?:OUTER)/i,/^(?:PARTITION)/i,/^(?:PRECEDING)/i,/^(?:PURGE)/i,/^(?:RANGE)/i,/^(?:REGEXP)/i,/^(?:RIGHT)/i,/^(?:RLIKE)/i,/^(?:ROW)/i,/^(?:ROWS)/i,/^(?:SCHEMA)/i,/^(?:SELECT)/i,/^(?:SEMI)/i,/^(?:SET)/i,/^(?:SHOW)/i,/^(?:SMALLINT)/i,/^(?:STRING)/i,/^(?:TABLE)/i,/^(?:THEN)/i,/^(?:TIMESTAMP)/i,/^(?:TINYINT)/i,/^(?:TO)/i,/^(?:TRUE)/i,/^(?:TRUNCATE)/i,/^(?:UNBOUNDED)/i,/^(?:UPDATE)/i,/^(?:USE)/i,/^(?:UNION)/i,/^(?:VIEW)/i,/^(?:VARCHAR)/i,/^(?:VALUES)/i,/^(?:WHEN)/i,/^(?:WHERE)/i,/^(?:WITH)/i,/^(?:OVER)/i,/^(?:ROLE)/i,/^(?:AVG\s*\()/i,/^(?:CAST\s*\()/i,/^(?:COUNT\s*\()/i,/^(?:MAX\s*\()/i,/^(?:MIN\s*\()/i,/^(?:STDDEV_POP\s*\()/i,/^(?:STDDEV_SAMP\s*\()/i,/^(?:SUM\s*\()/i,/^(?:VARIANCE\s*\()/i,/^(?:VAR_POP\s*\()/i,/^(?:VAR_SAMP\s*\()/i,/^(?:COLLECT_SET\s*\()/i,/^(?:COLLECT_LIST\s*\()/i,/^(?:CORR\s*\()/i,/^(?:COVAR_POP\s*\()/i,/^(?:COVAR_SAMP\s*\()/i,/^(?:EXTRACT\s*\()/i,/^(?:HISTOGRAM_NUMERIC\s*\()/i,/^(?:NTILE\s*\()/i,/^(?:PERCENTILE\s*\()/i,/^(?:PERCENTILE_APPROX\s*\()/i,/^(?:APPX_MEDIAN\s*\()/i,/^(?:EXTRACT\s*\()/i,/^(?:GROUP_CONCAT\s*\()/i,/^(?:NDV\s*\()/i,/^(?:STDDEV\s*\()/i,/^(?:VARIANCE_POP\s*\()/i,/^(?:VARIANCE_SAMP\s*\()/i,/^(?:CUME_DIST\s*\()/i,/^(?:DENSE_RANK\s*\()/i,/^(?:FIRST_VALUE\s*\()/i,/^(?:LAG\s*\()/i,/^(?:LAST_VALUE\s*\()/i,/^(?:LEAD\s*\()/i,/^(?:RANK\s*\()/i,/^(?:ROW_NUMBER\s*\()/i,/^(?:CUME_DIST\s*\()/i,/^(?:PERCENT_RANK\s*\()/i,/^(?:NTILE\s*\()/i,/^(?:PERCENT_RANK\s*\()/i,/^(?:SYSTEM\s*\()/i,/^(?:[0-9]+)/i,/^(?:[0-9]+(?:[YSL]|BD)?)/i,/^(?:[0-9]+E)/i,/^(?:[A-Za-z0-9_]+)/i,/^(?:\u2020)/i,/^(?:\u2021)/i,/^(?:\s+['])/i,/^(?:[^'\u2020\u2021]+)/i,/^(?:['])/i,/^(?:$)/i,/^(?:&&)/i,/^(?:\|\|)/i,/^(?:=)/i,/^(?:<)/i,/^(?:>)/i,/^(?:!=)/i,/^(?:<=)/i,/^(?:>=)/i,/^(?:<>)/i,/^(?:<=>)/i,/^(?:-)/i,/^(?:\*)/i,/^(?:\+)/i,/^(?:\/)/i,/^(?:%)/i,/^(?:\|)/i,/^(?:\^)/i,/^(?:&)/i,/^(?:,)/i,/^(?:\.)/i,/^(?::)/i,/^(?:;)/i,/^(?:~)/i,/^(?:!)/i,/^(?:\()/i,/^(?:\))/i,/^(?:\[)/i,/^(?:\])/i,/^(?:\$\{[^}]*\})/i,/^(?:`)/i,/^(?:[^`]+)/i,/^(?:`)/i,/^(?:')/i,/^(?:(?:\\\\|\\[']|[^'])+)/i,/^(?:')/i,/^(?:")/i,/^(?:(?:\\\\|\\["]|[^"])+)/i,/^(?:")/i,/^(?:$)/i,/^(?:.)/i,/^(?:.)/i,/^(?:.)/i,/^(?:.)/i,/^(?:.)/i,/^(?:.)/i,/^(?:.)/i,/^(?:.)/i,/^(?:.)/i],
conditions: {"hdfs":{"rules":[427,428,429,430,431,432,476],"inclusive":false},"doubleQuotedValue":{"rules":[469,470,479],"inclusive":false},"singleQuotedValue":{"rules":[466,467,478],"inclusive":false},"backtickedValue":{"rules":[463,464,477],"inclusive":false},"between":{"rules":[0,1,2,3,4,297,298,299,300,301,302,303,304,305,306,307,308,309,310,311,312,313,314,315,316,317,318,319,320,321,322,323,324,325,326,327,328,329,330,331,332,333,334,335,336,337,338,339,340,341,342,343,344,345,346,347,348,349,350,351,352,353,354,355,356,357,358,359,360,361,362,363,364,365,366,367,368,369,370,371,372,373,374,375,376,377,378,379,380,381,382,383,384,385,386,387,388,389,390,391,392,410,411,412,413,414,415,416,417,423,424,425,426,433,434,435,436,437,438,439,440,441,442,443,444,445,446,447,448,449,450,451,452,453,454,455,456,457,458,459,460,461,462,465,468,471,472,473,480],"inclusive":true},"hive":{"rules":[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,159,160,161,162,163,164,165,166,167,168,169,170,171,172,173,174,175,176,177,178,179,180,181,298,299,300,301,302,303,304,305,306,307,308,309,310,311,312,313,314,315,316,317,318,319,320,321,322,323,324,325,326,327,328,329,330,331,332,333,334,335,336,337,338,339,340,341,342,343,344,345,346,347,348,349,350,351,352,353,354,355,356,357,358,359,360,361,362,363,364,365,366,367,368,369,370,371,372,373,374,375,376,377,378,379,380,381,382,383,384,385,386,387,388,389,390,391,392,393,394,395,396,397,398,399,400,401,402,410,411,412,413,414,415,416,417,418,419,423,424,425,426,433,434,435,436,437,438,439,440,441,442,443,444,445,446,447,448,449,450,451,452,453,454,455,456,457,458,459,460,461,462,465,468,471,472,474,480],"inclusive":true},"impala":{"rules":[0,1,2,3,4,182,183,184,185,186,187,188,189,190,191,192,193,194,195,196,197,198,199,200,201,202,203,204,205,206,207,208,209,210,211,212,213,214,215,216,217,218,219,220,221,222,223,224,225,226,227,228,229,230,231,232,233,234,235,236,237,238,239,240,241,242,243,244,245,246,247,248,249,250,251,252,253,254,255,256,257,258,259,260,261,262,263,264,265,266,267,268,269,270,271,272,273,274,275,276,277,278,279,280,281,282,283,284,285,286,287,288,289,290,291,292,293,294,295,296,298,299,300,301,302,303,304,305,306,307,308,309,310,311,312,313,314,315,316,317,318,319,320,321,322,323,324,325,326,327,328,329,330,331,332,333,334,335,336,337,338,339,340,341,342,343,344,345,346,347,348,349,350,351,352,353,354,355,356,357,358,359,360,361,362,363,364,365,366,367,368,369,370,371,372,373,374,375,376,377,378,379,380,381,382,383,384,385,386,387,388,389,390,391,392,403,404,405,406,407,408,409,410,411,412,413,414,415,416,417,420,421,422,423,424,425,426,433,434,435,436,437,438,439,440,441,442,443,444,445,446,447,448,449,450,451,452,453,454,455,456,457,458,459,460,461,462,465,468,471,472,475,480],"inclusive":true},"INITIAL":{"rules":[0,1,2,3,4,298,299,300,301,302,303,304,305,306,307,308,309,310,311,312,313,314,315,316,317,318,319,320,321,322,323,324,325,326,327,328,329,330,331,332,333,334,335,336,337,338,339,340,341,342,343,344,345,346,347,348,349,350,351,352,353,354,355,356,357,358,359,360,361,362,363,364,365,366,367,368,369,370,371,372,373,374,375,376,377,378,379,380,381,382,383,384,385,386,387,388,389,390,391,392,410,411,412,413,414,415,416,417,423,424,425,426,433,434,435,436,437,438,439,440,441,442,443,444,445,446,447,448,449,450,451,452,453,454,455,456,457,458,459,460,461,462,465,468,471,472,480],"inclusive":true}}
});
return lexer;
})();
parser.lexer = lexer;
function Parser () {
  this.yy = {};
}
Parser.prototype = parser;parser.Parser = Parser;
return new Parser;
})();


if (typeof require !== 'undefined' && typeof exports !== 'undefined') {
exports.parser = sqlAutocompleteParser;
exports.Parser = sqlAutocompleteParser.Parser;
exports.parse = function () { return sqlAutocompleteParser.parse.apply(sqlAutocompleteParser, arguments); };
exports.main = function commonjsMain(args) {
    if (!args[1]) {
        console.log('Usage: '+args[0]+' FILE');
        process.exit(1);
    }
    var source = require('fs').readFileSync(require('path').normalize(args[1]), "utf8");
    return exports.parser.parse(source);
};
if (typeof module !== 'undefined' && require.main === module) {
  exports.main(process.argv.slice(1));
}
}