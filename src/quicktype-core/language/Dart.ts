import {
    Type,
    EnumType,
    UnionType,
    ClassType,
    ClassProperty,
    TransformedStringTypeKind,
    PrimitiveStringTypeKind
} from "../Type";
import { matchType, nullableFromUnion, directlyReachableSingleNamedType } from "../TypeUtils";
import { Sourcelike, maybeAnnotated, modifySource } from "../Source";
import {
    utf16LegalizeCharacters,
    escapeNonPrintableMapper,
    utf16ConcatMap,
    standardUnicodeHexEscape,
    isAscii,
    isLetter,
    isDigit,
    splitIntoWords,
    combineWords,
    allUpperWordStyle,
    firstUpperWordStyle,
    allLowerWordStyle,
    isPrintable,
    decapitalize,
    pascalCase
} from "../support/Strings";

import { StringTypeMapping } from "../TypeBuilder";

import { Name, Namer, funPrefixNamer, DependencyName } from "../Naming";
import { ConvenienceRenderer, ForbiddenWordsInfo } from "../ConvenienceRenderer";
import { TargetLanguage } from "../TargetLanguage";
import { Option, BooleanOption, getOptionValues, OptionValues, StringOption } from "../RendererOptions";
import { anyTypeIssueAnnotation, nullTypeIssueAnnotation } from "../Annotation";
import { defined } from "../support/Support";
import { RenderContext } from "../Renderer";
import { arrayIntercalate } from "collection-utils";

export const dartOptions = {
    justTypes: new BooleanOption("just-types", "Types only", false),
    codersInClass: new BooleanOption("coders-in-class", "Put encoder & decoder in Class", false),
    methodNamesWithMap: new BooleanOption("from-map", "Use method names fromMap() & toMap()", false),
    requiredProperties: new BooleanOption("required-props", "Make all properties required", false),
    finalProperties: new BooleanOption("final-props", "Make all properties final", false),
    generateCopyWith: new BooleanOption("copy-with", "Generate CopyWith method", false),
    useFreezed: new BooleanOption("use-freezed", "Generate class definitions with @freezed compatibility", false),
    useHive: new BooleanOption("use-hive", "Generate annotations for Hive type adapters", false),
    hiveAnnotationCounter: new StringOption("hive-annotation-counter", "value of type annotation for hive classes: default zero", "", "0"),
    useEquatable: new BooleanOption("use-equatable", "class will extend Equatable", false),
    useNullSafety: new BooleanOption("use-null-safety", "class will use null safe conventions", false),
    partName: new StringOption("part-name", "Use this name in `part` directive", "NAME", "")
};

export class DartTargetLanguage extends TargetLanguage {
    constructor() {
        super("Dart", ["dart"], "dart");
    }

    protected getOptions(): Option<any>[] {
        return [
            dartOptions.justTypes,
            dartOptions.codersInClass,
            dartOptions.methodNamesWithMap,
            dartOptions.requiredProperties,
            dartOptions.finalProperties,
            dartOptions.generateCopyWith,
            dartOptions.useFreezed,
            dartOptions.useHive,
            dartOptions.hiveAnnotationCounter,
            dartOptions.useEquatable,
            dartOptions.useNullSafety,
            dartOptions.partName
        ];
    }

    get supportsOptionalClassProperties(): boolean {
        return true;
    }

    get supportsUnionsWithBothNumberTypes(): boolean {
        return true;
    }

    get stringTypeMapping(): StringTypeMapping {
        const mapping: Map<TransformedStringTypeKind, PrimitiveStringTypeKind> = new Map();
        mapping.set("date", "date");
        mapping.set("date-time", "date-time");
        //        mapping.set("uuid", "uuid");
        return mapping;
    }

    protected makeRenderer(renderContext: RenderContext, untypedOptionValues: { [name: string]: any }): DartRenderer {
        const options = getOptionValues(dartOptions, untypedOptionValues);
        return new DartRenderer(this, renderContext, options);
    }
}

const keywords = [
    "abstract",
    "do",
    "import",
    "super",
    "as",
    "dynamic",
    "in",
    "switch",
    "assert",
    "else",
    "interface",
    "sync*",
    "async",
    "enum",
    "is",
    "this",
    "async*",
    "export",
    "library",
    "throw",
    "await",
    "external",
    "mixin",
    "true",
    "break",
    "extends",
    "new",
    "try",
    "case",
    "factory",
    "null",
    "typedef",
    "catch",
    "false",
    "operator",
    "var",
    "class",
    "final",
    "part",
    "void",
    "const",
    "finally",
    "rethrow",
    "while",
    "continue",
    "for",
    "return",
    "with",
    "covariant",
    "get",
    "set",
    "yield",
    "default",
    "if",
    "static",
    "yield*",
    "deferred",
    "implements",
    "int",
    "double",
    "bool",
    "Map",
    "List",
    "String",
    "File",
    "fromJson",
    "toJson",
    "fromMap",
    "toMap"
];

const typeNamingFunction = funPrefixNamer("types", n => dartNameStyle(true, false, n));
const propertyNamingFunction = funPrefixNamer("properties", n => dartNameStyle(false, false, n));
const enumCaseNamingFunction = funPrefixNamer("enum-cases", n => dartNameStyle(true, true, n));

// Escape the dollar sign, which is used in string interpolation
const stringEscape = utf16ConcatMap(
    escapeNonPrintableMapper(cp => isPrintable(cp) && cp !== 0x24, standardUnicodeHexEscape)
);

function isStartCharacter(codePoint: number): boolean {
    if (codePoint === 0x5f) return false; // underscore
    return isAscii(codePoint) && isLetter(codePoint);
}

function isPartCharacter(codePoint: number): boolean {
    return isStartCharacter(codePoint) || (isAscii(codePoint) && isDigit(codePoint));
}

const legalizeName = utf16LegalizeCharacters(isPartCharacter);

// FIXME: Handle acronyms consistently.  In particular, that means that
// we have to use namers to produce the getter and setter names - we can't
// just capitalize and concatenate.
// https://stackoverflow.com/questions/8277355/naming-convention-for-upper-case-abbreviations
function dartNameStyle(startWithUpper: boolean, upperUnderscore: boolean, original: string): string {
    const words = splitIntoWords(original);
    const firstWordStyle = upperUnderscore
        ? allUpperWordStyle
        : startWithUpper
            ? firstUpperWordStyle
            : allLowerWordStyle;
    const restWordStyle = upperUnderscore ? allUpperWordStyle : firstUpperWordStyle;
    return combineWords(
        words,
        legalizeName,
        firstWordStyle,
        restWordStyle,
        firstWordStyle,
        restWordStyle,
        upperUnderscore ? "_" : "",
        isStartCharacter
    );
}

type TopLevelDependents = {
    encoder: Name;
    decoder: Name;
};

export class DartRenderer extends ConvenienceRenderer {
    private readonly _gettersAndSettersForPropertyName = new Map<Name, [Name, Name]>();
    private _needEnumValues = false;
    private classCounter = parseInt(this._options.hiveAnnotationCounter, 10);
    private classPropertyCounter = 0;
    private readonly _topLevelDependents = new Map<Name, TopLevelDependents>();
    private readonly _enumValues = new Map<EnumType, Name>();

    constructor(
        targetLanguage: TargetLanguage,
        renderContext: RenderContext,
        private readonly _options: OptionValues<typeof dartOptions>
    ) {
        super(targetLanguage, renderContext);
    }

    protected forbiddenNamesForGlobalNamespace(): string[] {
        return keywords;
    }

    protected forbiddenForObjectProperties(_c: ClassType, _className: Name): ForbiddenWordsInfo {
        return { names: [], includeGlobalForbidden: true };
    }

    protected makeNamedTypeNamer(): Namer {
        return typeNamingFunction;
    }

    protected namerForObjectProperty(): Namer {
        return propertyNamingFunction;
    }

    protected makeUnionMemberNamer(): Namer {
        return propertyNamingFunction;
    }

    protected makeEnumCaseNamer(): Namer {
        return enumCaseNamingFunction;
    }

    protected unionNeedsName(u: UnionType): boolean {
        return nullableFromUnion(u) === null;
    }

    protected namedTypeToNameForTopLevel(type: Type): Type | undefined {
        // If the top-level type doesn't contain any classes or unions
        // we have to define a class just for the `FromJson` method, in
        // emitFromJsonForTopLevel.
        return directlyReachableSingleNamedType(type);
    }

    protected get toJson(): string {
        return `to${this._options.methodNamesWithMap ? "Map" : "Json"}`;
    }

    protected get fromJson(): string {
        return `from${this._options.methodNamesWithMap ? "Map" : "Json"}`;
    }

    protected makeTopLevelDependencyNames(_t: Type, name: Name): DependencyName[] {
        const encoder = new DependencyName(
            propertyNamingFunction,
            name.order,
            lookup => `${lookup(name)}_${this.toJson}`
        );
        const decoder = new DependencyName(
            propertyNamingFunction,
            name.order,
            lookup => `${lookup(name)}_${this.fromJson}`
        );
        this._topLevelDependents.set(name, { encoder, decoder });
        return [encoder, decoder];
    }

    protected makeNamesForPropertyGetterAndSetter(
        _c: ClassType,
        _className: Name,
        _p: ClassProperty,
        _jsonName: string,
        name: Name
    ): [Name, Name] {
        const getterName = new DependencyName(propertyNamingFunction, name.order, lookup => `get_${lookup(name)}`);
        const setterName = new DependencyName(propertyNamingFunction, name.order, lookup => `set_${lookup(name)}`);
        return [getterName, setterName];
    }

    protected makePropertyDependencyNames(
        c: ClassType,
        className: Name,
        p: ClassProperty,
        jsonName: string,
        name: Name
    ): Name[] {
        const getterAndSetterNames = this.makeNamesForPropertyGetterAndSetter(c, className, p, jsonName, name);
        this._gettersAndSettersForPropertyName.set(name, getterAndSetterNames);
        return getterAndSetterNames;
    }

    protected makeNamedTypeDependencyNames(t: Type, name: Name): DependencyName[] {
        if (!(t instanceof EnumType)) return [];
        const enumValue = new DependencyName(propertyNamingFunction, name.order, lookup => `${lookup(name)}_values`);
        this._enumValues.set(t, enumValue);
        return [enumValue];
    }

    protected emitFileHeader(): void {
        if (this.leadingComments !== undefined) {
            this.emitCommentLines(this.leadingComments);
        }

        if (this._options.justTypes) return;

        this.emitLine("// To parse this JSON data, do");
        this.emitLine("//");
        this.forEachTopLevel("none", (_t, name) => {
            const { decoder } = defined(this._topLevelDependents.get(name));
            this.emitLine("//     final ", modifySource(decapitalize, name), " = ", decoder, "(jsonString);");
        });

        this.ensureBlankLine();
        //meta.dart not needed for null safe / Dart versions >= 2.12
        if (this._options.requiredProperties && this._options.useNullSafety == false) {
            this.emitLine("import 'package:meta/meta.dart';");
        }
        if (this._options.useFreezed) {
            this.emitLine("import 'package:freezed_annotation/freezed_annotation.dart';");
        }
        if (this._options.useHive) {
            this.emitLine("import 'package:hive/hive.dart';");
        }

        if (this._options.useEquatable) {
            this.emitLine("import 'package:equatable/equatable.dart';");
        }

        this.emitLine("import 'dart:convert';");
        if (this._options.useFreezed || this._options.useHive) {
            this.ensureBlankLine();
            const optionNameIsEmpty = this._options.partName.length === 0;
            // FIXME: This should use a `Name`, not `modifySource`
            const name = modifySource(
                pascalCase,
                optionNameIsEmpty ? [...this.topLevels.keys()][0] : this._options.partName
            );
            if (this._options.useFreezed) {
                this.emitLine("part '", name, ".freezed.dart';");
            }
            if (!this._options.justTypes) {
                this.emitLine("part '", name, ".g.dart';");
            }
        }
    }

    protected emitDescriptionBlock(lines: Sourcelike[]): void {
        this.emitCommentLines(lines, " * ", "/**", " */");
    }

    protected emitBlock(line: Sourcelike, f: () => void): void {
        this.emitLine(line, " {");
        this.indent(f);
        this.emitLine("}");
    }

    protected dartType(t: Type, withIssues: boolean = false): Sourcelike {
        return matchType<Sourcelike>(
            t,
            _anyType => maybeAnnotated(withIssues, anyTypeIssueAnnotation, "dynamic"),
            _nullType => maybeAnnotated(withIssues, nullTypeIssueAnnotation, "dynamic"),
            _boolType => "bool",
            _integerType => "int",
            _doubleType => "double",
            _stringType => "String",
            arrayType => ["List<", this.dartType(arrayType.items, withIssues), ">"],
            classType => this.nameForNamedType(classType),
            mapType => ["Map<String, ", this.dartType(mapType.values, withIssues), ">"],
            enumType => this.nameForNamedType(enumType),
            unionType => {
                const maybeNullable = nullableFromUnion(unionType);
                if (maybeNullable === null) {
                    return "dynamic";
                }
                return this.dartType(maybeNullable, withIssues);
            },
            transformedStringType => {
                switch (transformedStringType.kind) {
                    case "date-time":
                    case "date":
                        return "DateTime";
                    default:
                        return "String";
                }
            }
        );
    }

    protected mapList(itemType: Sourcelike, nullable: boolean, list: Sourcelike, mapper: Sourcelike): Sourcelike {
        if (nullable == true) {
            return [list, " == null ? null : ", "List<", itemType, ">.from(", list, "?.map((x) => ", mapper, ")?? [])"];
        }
        return ["List<", itemType, ">.from(", list, ".map((x) => ", mapper, "))"];
    }

    protected mapMap(valueType: Sourcelike, nullable: boolean, map: Sourcelike, valueMapper: Sourcelike): Sourcelike {
        if (nullable == true) {
            return [map, " == null ? null : ", "Map.from(", map, ").map((k, v) => MapEntry<String, ", valueType, ">(k, ", valueMapper, "))"]
        }
        return ["Map.from(", map, ").map((k, v) => MapEntry<String, ", valueType, ">(k, ", valueMapper, "))"];
    }

    protected fromDynamicExpression(t: Type, nullable: boolean, ...dynamic: Sourcelike[]): Sourcelike {
        return matchType<Sourcelike>(
            t,
            _anyType => nullable ? [dynamic, " == null ? null : ", dynamic] : dynamic,
            _nullType => nullable ? [dynamic, " == null ? null : ", dynamic] : dynamic,
            _boolType => nullable ? [dynamic, " == null ? null : ", dynamic] : dynamic,
            _integerType => nullable ? [dynamic, " == null ? null : ", dynamic] : dynamic,
            _doubleType => nullable ? [dynamic, " == null ? null : ", dynamic, "?.toDouble()"] : [dynamic, ".toDouble()"],
            _stringType => nullable ? [dynamic, " == null ? null : ", dynamic] : dynamic,
            arrayType =>
                this.mapList(this.dartType(arrayType.items), nullable, dynamic, this.fromDynamicExpression(arrayType.items, nullable, "x")),
            classType => [this.nameForNamedType(classType), ".", this.fromJson, "(", dynamic, ")"],
            mapType =>
                this.mapMap(this.dartType(mapType.values), nullable, dynamic, this.fromDynamicExpression(mapType.values, nullable, "v")),
            enumType => [defined(this._enumValues.get(enumType)), ".map[", dynamic, "]"],
            unionType => {
                const maybeNullable = nullableFromUnion(unionType);
                if (maybeNullable === null) {
                    return nullable ? [dynamic, " == null ? null : ", dynamic] : dynamic;
                }
                return [dynamic, " == null ? null : ", this.fromDynamicExpression(maybeNullable, nullable, dynamic)];
            },
            transformedStringType => {
                switch (transformedStringType.kind) {
                    case "date-time":
                    case "date":
                        return [nullable ? "DateTime.tryParse(" : "DateTime.parse(", dynamic, ")"];
                    default:
                        return nullable ? [dynamic, " == null ? null : ", dynamic] : dynamic;
                }
            }
        );
    }

    protected toDynamicExpression(t: Type, nullable: boolean, ...dynamic: Sourcelike[]): Sourcelike {
        return matchType<Sourcelike>(
            t,
            _anyType => nullable ? [dynamic, " == null ? null : ", dynamic] : dynamic,
            _nullType => nullable ? [dynamic, " == null ? null : ", dynamic] : dynamic,
            _boolType => nullable ? [dynamic, " == null ? null : ", dynamic] : dynamic,
            _integerType => nullable ? [dynamic, " == null ? null : ", dynamic] : dynamic,
            _doubleType => nullable ? [dynamic, " == null ? null : ", dynamic] : dynamic,
            _stringType => nullable ? [dynamic, " == null ? null : ", dynamic] : dynamic,
            arrayType => this.mapList("dynamic", nullable, dynamic, this.toDynamicExpression(arrayType.items, false, "x")),
            _classType => nullable ? [dynamic, " == null ? null : ", [dynamic, "?.", this.toJson, "()", " ?? {}"]] : [dynamic, ".", this.toJson, "()"],
            mapType => this.mapMap("dynamic", nullable, dynamic, this.toDynamicExpression(mapType.values, nullable, "v")),
            enumType => [defined(this._enumValues.get(enumType)), ".reverse[", dynamic, "]"],
            unionType => {
                const maybeNullable = nullableFromUnion(unionType);
                if (maybeNullable === null) {
                    return dynamic;
                }
                return [dynamic, " == null ? null : ", this.toDynamicExpression(maybeNullable, nullable, dynamic)];
            },
            transformedStringType => {
                switch (transformedStringType.kind) {
                    case "date-time":
                        return [dynamic,
                            nullable ? "?" : "",
                            ".toIso8601String()"];
                    case "date":
                        return [
                            '"${',
                            dynamic,
                            nullable ? "?" : "",
                            ".year.toString().padLeft(4, '0')",
                            "}-${",
                            dynamic,
                            nullable ? "?" : "",
                            ".month.toString().padLeft(2, '0')}-${",
                            dynamic,
                            nullable ? "?" : "",
                            ".day.toString().padLeft(2, '0')}\""
                        ];
                    default:
                        return nullable ? [dynamic, " == null ? null : ", dynamic] : dynamic;
                }
            }
        );
    }

    protected emitClassDefinition(c: ClassType, className: Name): void {

        if (this._options.useEquatable == true && this._options.finalProperties == false) {
            throw Error("Cannot use --use-equatable without --final-props option");
        }
        const useNullSafe = (p: ClassProperty) => {
            return p.isOptional && this._options.useNullSafety == true;
        }

        const nullSafePrefix = (p: ClassProperty) => {
            var requiredPrefix = "@required ";
            if (this._options.useNullSafety == true) {
                requiredPrefix = "required ";
                if (p.isOptional) {
                    return "";
                }
                return requiredPrefix;
            }
            if (this._options.finalProperties == true) {
                return requiredPrefix;
            }
            return "";
        };

        const nullSafeDeclaration = (p: ClassProperty) => {
            if (p.isOptional) {
                return "? ";
            } else {
                return " ";
            }
        };

        this.emitDescription(this.descriptionForType(c));
        if (this._options.useHive) {
            this.classCounter++;
            this.emitLine(`@HiveType(typeId: ${this.classCounter})`);
            this.classPropertyCounter = 0;
        }
        this.emitBlock(["class ", className, this._options.useEquatable ? " extends Equatable" : ""], () => {
            if (c.getProperties().size === 0) {
                this.emitLine(this._options.useEquatable ? "const " : "", className, "();");
            } else {
                this.emitLine(this._options.useEquatable ? "const " : "", className, "({");
                this.indent(() => {
                    this.forEachClassProperty(c, "none", (name, _, _p) => {
                        this.emitLine(nullSafePrefix(_p), "this.", name, ",");
                    });
                });
                this.emitLine("});");
                this.ensureBlankLine();

                this.forEachClassProperty(c, "none", (name, jsonName, p) => {
                    const description = this.descriptionForClassProperty(c, jsonName);
                    if (description !== undefined) {
                        this.emitDescription(description);
                    }

                    if (this._options.useHive) {
                        this.classPropertyCounter++;
                        this.emitLine(`@HiveField(${this.classPropertyCounter})`);
                    }

                    this.emitLine(
                        this._options.finalProperties ? "final " : "",
                        this.dartType(p.type, true),
                        nullSafeDeclaration(p),
                        name,
                        ";"
                    );
                });
            }

            if (this._options.generateCopyWith) {
                this.ensureBlankLine();
                this.emitLine(className, " copyWith({");
                this.indent(() => {
                    this.forEachClassProperty(c, "none", (name, _, _p) => {
                        this.emitLine(nullSafePrefix(_p), this.dartType(_p.type, true), nullSafeDeclaration(_p), name, ",");
                    });
                });
                this.emitLine("}) => ");
                this.indent(() => {
                    this.emitLine(className, "(");
                    this.indent(() => {
                        this.forEachClassProperty(c, "none", (name, _, _p) => {
                            if (this._options.useNullSafety == true) {
                                if (_p.isOptional == true) {
                                    this.emitLine(name, ": ", name, " ?? ", "this.", name, ",");
                                } else {
                                    this.emitLine(name, ": ", name, ",");
                                }
                            } else {
                                this.emitLine(name, ": ", name, " ?? ", "this.", name, ",");
                            }
                        });
                    });
                    this.emitLine(");");
                });
            }

            if (this._options.justTypes) return;

            if (this._options.codersInClass) {
                this.ensureBlankLine();
                this.emitLine(
                    "factory ",
                    className,
                    ".from",
                    this._options.methodNamesWithMap ? "Json" : "RawJson",
                    "(String str) => ",
                    className,
                    ".",
                    this.fromJson,
                    "(json.decode(str));"
                );

                this.ensureBlankLine();
                this.emitLine(
                    "String ",
                    this._options.methodNamesWithMap ? "toJson() => " : "toRawJson() => ",
                    "json.encode(",
                    this.toJson,
                    "());"
                );
            }

            this.ensureBlankLine();
            this.emitLine("factory ", className, ".", this.fromJson, "(Map<String, dynamic> json) => ", className, "(");
            this.indent(() => {
                this.forEachClassProperty(c, "none", (name, jsonName, property) => {
                    this.emitLine(
                        name,
                        ": ",
                        this.fromDynamicExpression(property.type, useNullSafe(property), 'json["', stringEscape(jsonName), '"]'),
                        ","
                    );
                });
            });
            this.emitLine(");");

            this.ensureBlankLine();

            this.emitLine("Map<String, dynamic> ", this.toJson, "() => {");
            this.indent(() => {
                this.forEachClassProperty(c, "none", (name, jsonName, property) => {
                    this.emitLine(
                        '"',
                        stringEscape(jsonName),
                        '": ',
                        this.toDynamicExpression(property.type, useNullSafe(property), name),
                        ","
                    );
                });
            });
            this.emitLine("};");

            if (this._options.useEquatable && this._options.finalProperties) {
                const nonOptionalProperties: Name[] = [];
                this.forEachClassProperty(c, "none", (name, _, p) => {
                    if (p.isOptional == false) {
                        nonOptionalProperties.push(name);
                    }
                });
                this.ensureBlankLine();
                this.emitLine("@override");
                this.emitLine("//only non nullable fields can be used for Equatable classes");
                if (nonOptionalProperties.length === 0) {
                    this.emitLine("List<Object?> get props => [];");
                } else {
                    this.emitLine("List<Object?> get props => [");
                    this.indent(() => {
                        nonOptionalProperties.forEach((name) => this.emitLine(name, ","));
                    });
                    this.emitLine("];");
                }
                this.ensureBlankLine();
                this.emitLine("@override");
                this.emitLine("bool get stringify => true;")

            }


        });
    }

    protected emitFreezedClassDefinition(c: ClassType, className: Name): void {
        var requiredPrefix = "@required ";
        if (this._options.useNullSafety == true) {
            requiredPrefix = "required ";
        }
        var required = this._options.useNullSafety == true || this._options.requiredProperties == true;

        this.emitDescription(this.descriptionForType(c));

        this.emitLine("@freezed");
        this.emitBlock(["abstract class ", className, " with _$", className], () => {
            if (c.getProperties().size === 0) {
                this.emitLine("const factory ", className, "() = _", className, ";");
            } else {
                this.emitLine("const factory ", className, "({");
                this.indent(() => {
                    this.forEachClassProperty(c, "none", (name, _, _p) => {
                        this.emitLine(
                            required ? requiredPrefix : "",
                            this.dartType(_p.type, true),
                            " ",
                            name,
                            ","
                        );
                    });
                });
                this.emitLine("}) = _", className, ";");
            }

            if (this._options.justTypes) return;

            this.ensureBlankLine();
            this.emitLine(
                // factory PublicAnswer.fromJson(Map<String, dynamic> json) => _$PublicAnswerFromJson(json);
                "factory ",
                className,
                ".fromJson(Map<String, dynamic> json) => ",
                "_$",
                className,
                "FromJson(json);"
            );
        });
    }

    protected emitEnumDefinition(e: EnumType, enumName: Name): void {
        const caseNames: Sourcelike[] = Array.from(e.cases).map(c => this.nameForEnumCase(e, c));
        this.emitDescription(this.descriptionForType(e));
        this.emitLine("enum ", enumName, " { ", arrayIntercalate(", ", caseNames), " }");

        if (this._options.justTypes) return;

        this.ensureBlankLine();
        this.emitLine("final ", defined(this._enumValues.get(e)), " = EnumValues({");
        this.indent(() => {
            this.forEachEnumCase(e, "none", (name, jsonName, pos) => {
                const comma = pos === "first" || pos === "middle" ? "," : [];
                this.emitLine('"', stringEscape(jsonName), '": ', enumName, ".", name, comma);
            });
        });
        this.emitLine("});");

        this._needEnumValues = true;
    }

    protected emitEnumValues(): void {
        this.ensureBlankLine();
        if (this._options.useNullSafety == true) {
            this.emitMultiline(`class EnumValues<T> {
                Map<String, T> map;
                Map<T, String>? reverseMap;
            
                EnumValues(this.map);
            
                Map<T, String> get reverse {
                    if (reverseMap == null) {
                        reverseMap = map.map((k, v) => new MapEntry(v, k));
                    }
                    return reverseMap!;
                }
            }`);
        } else {
            this.emitMultiline(`class EnumValues<T> {
                Map<String, T> map;
                Map<T, String> reverseMap;
            
                EnumValues(this.map);
            
                Map<T, String> get reverse {
                    if (reverseMap == null) {
                        reverseMap = map.map((k, v) => new MapEntry(v, k));
                    }
                    return reverseMap;
                }
            }`);
        }

    }

    protected emitSourceStructure(): void {
        this.emitFileHeader();

        if (!this._options.justTypes && !this._options.codersInClass) {
            this.forEachTopLevel("leading-and-interposing", (t, name) => {
                const { encoder, decoder } = defined(this._topLevelDependents.get(name));

                this.emitLine(
                    this.dartType(t),
                    " ",
                    decoder,
                    "(String str) => ",
                    this.fromDynamicExpression(t, false, "json.decode(str)"),
                    ";"
                );

                this.ensureBlankLine();

                this.emitLine(
                    "String ",
                    encoder,
                    "(",
                    this.dartType(t),
                    " data) => json.encode(",
                    this.toDynamicExpression(t, false, "data"),
                    ");"
                );

                // this.emitBlock(["String ", encoder, "(", this.dartType(t), " data)"], () => {
                //     this.emitJsonEncoderBlock(t);
                // });
            });
        }

        this.forEachNamedType(
            "leading-and-interposing",
            (c: ClassType, n: Name) =>
                this._options.useFreezed ? this.emitFreezedClassDefinition(c, n) : this.emitClassDefinition(c, n),
            (e, n) => this.emitEnumDefinition(e, n),
            (_e, _n) => {
                // We don't support this yet.
            }
        );

        if (this._needEnumValues) {
            this.emitEnumValues();
        }
    }
}
