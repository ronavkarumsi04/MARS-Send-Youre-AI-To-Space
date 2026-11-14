package toml

// tomlType represents any Go type that corresponds to a TOML type.
// While the first draft of the TOML spec has a simplistic type system that
// probably doesn't need this level of sophistication, we seem to be militating
// toward adding real composite types.
type tomlType interface {
	typeString() string
}

// typeEqual accepts any two types and returns true if they are equal.
func typeEqual(t1, t2 tomlType) bool {
	if t1 == nil || t2 == nil {
		return false
	}
	return t1.typeString() == t2.typeString()
}

func typeIsTable(t tomlType) bool {
	return typeEqual(t, tomlHash) || typeEqual(t, tomlArrayHash)
}

type tomlBaseTypeV2 string

func (btype tomlBaseTypeV2) typeString() string { return string(btype) }
func (btype tomlBaseTypeV2) String() string     { return btype.typeString() }

var (
	tomlInteger   tomlBaseTypeV2 = "Integer"
	tomlFloat     tomlBaseTypeV2 = "Float"
	tomlDatetime  tomlBaseTypeV2 = "Datetime"
	tomlString    tomlBaseTypeV2 = "String"
	tomlBool      tomlBaseTypeV2 = "Bool"
	tomlArray     tomlBaseTypeV2 = "Array"
	tomlHash      tomlBaseTypeV2 = "Hash"
	tomlArrayHash tomlBaseTypeV2 = "ArrayHash"
)

// typeOfPrimitive returns a tomlType of any primitive value in TOML.
// Primitive values are: Integer, Float, Datetime, String and Bool.
//
// Passing a lexer item other than the following will cause a BUG message
// to occur: itemString, itemBool, itemInteger, itemFloat, itemDatetime.
func (p *parser) typeOfPrimitive(lexItem item) tomlType {
	switch lexItem.typ {
	case itemInteger:
		return tomlInteger
	case itemFloat:
		return tomlFloat
	case itemDatetime:
		return tomlDatetime
	case itemString, itemStringEsc:
		return tomlString
	case itemMultilineString:
		return tomlString
	case itemRawString:
		return tomlString
	case itemRawMultilineString:
		return tomlString
	case itemBool:
		return tomlBool
	}
	p.bug("Cannot infer primitive type of lex item '%s'.", lexItem)
	panic("unreachable")
}
