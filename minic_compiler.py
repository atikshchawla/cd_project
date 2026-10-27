#!/usr/bin/env python3
"""Standalone educational C-subset interpreter/compiler-stage demo.
Supports int/void functions, recursion, 1-D int arrays, initializers, indexing,
if/else, while/for, break/continue/return, arithmetic, comparisons, ++/--,
compound assignments, print(expr), and basic printf("%d", value).
The IR and assembly are explanatory listings; execution uses the AST interpreter.
"""
from dataclasses import dataclass, field
import argparse, copy, io, os, re, sys, tempfile, unittest

class CompileError(Exception): pass

@dataclass
class Tok:
    kind: str
    value: str
    line: int
    col: int

KEYWORDS = {"int","void","struct","union","new","delete","if","else","while","for","print","printf","return","break","continue","sizeof"}

def lex(src):
    pat = re.compile(r'(?P<SPACE>\s+)|(?P<COMMENT>//[^\n]*|/\*[\s\S]*?\*/)|(?P<STRING>"(?:\\.|[^"\\])*")|(?P<NUMBER>\d+)|(?P<ID>[A-Za-z_]\w*)|(?P<OP>\+\+|--|->|\+=|-=|\*=|/=|%=|&&|\|\||==|!=|<=|>=|[+\-*/%<>=!&.])|(?P<PUNC>[(){}\[\],;.\-])|(?P<BAD>.)')
    out=[]; line=col=1
    for m in pat.finditer(src):
        v,k=m.group(),m.lastgroup; sl,sc=line,col
        if "\n" in v: line+=v.count("\n"); col=len(v.rsplit("\n",1)[-1])+1
        else: col+=len(v)
        if k in ("SPACE","COMMENT"): continue
        if k=="BAD": raise CompileError(f"Lexical error at {sl}:{sc}: {v!r}")
        if k=="ID" and v in KEYWORDS: k="KEYWORD"
        out.append(Tok(k,v,sl,sc))
    out.append(Tok("EOF","",line,col)); return out

@dataclass
class N:
    kind: str
    value: object=None
    children: list=field(default_factory=list)
    line: int=0
    col: int=0

class Parser:
    def __init__(self,t): self.t=t; self.i=0
    @property
    def c(self): return self.t[self.i]
    def take(self):
        x=self.c
        if self.i<len(self.t)-1:self.i+=1
        return x
    def accept(self,v):
        if self.c.value==v:self.take();return True
        return False
    def expect(self,v):
        if self.c.value!=v: raise CompileError(f"Syntax error at {self.c.line}:{self.c.col}: expected {v!r}, got {self.c.value!r}")
        return self.take()
    def parse(self):
        a=[]
        while self.c.kind!="EOF": a.append(self.top())
        return N("program",children=a)
    def type_spec(self):
        t=self.take()
        if t.value in ("int","void"): return t.value
        if t.value in ("struct","union"):
            nm=self.take()
            if nm.kind!="ID": raise CompileError("Expected struct/union name")
            return t.value+" "+nm.value
        raise CompileError("Expected type")
    def top(self):
        if self.c.value in ("struct","union") and self.t[self.i+2].value=="{":
            kind=self.take().value; name=self.take().value; self.expect("{"); fields=[]
            while self.c.value!="}":
                typ=self.type_spec(); stars=0
                while self.accept("*"): stars+=1
                fn=self.take()
                if fn.kind!="ID": raise CompileError("Expected field name")
                dims=[]
                while self.accept("["):
                    dims.append(self.expr()); self.expect("]")
                self.expect(";"); fields.append((typ+"*"*stars,fn.value,dims))
            self.expect("}"); self.accept(";")
            return N("type_def",(kind,name,fields))
        typ=self.type_spec(); stars=0
        while self.accept("*"): stars+=1
        name=self.take()
        if name.kind!="ID": raise CompileError("Expected identifier")
        if self.accept("("):
            ps=[]
            if self.c.value!=")":
                if self.c.value=="void" and self.t[self.i+1].value==")": self.take()
                else:
                    while True:
                        pt=self.type_spec(); pst=0
                        while self.accept("*"): pst+=1
                        pn=self.take()
                        if pn.kind!="ID": raise CompileError("Expected parameter name")
                        dims=[]
                        while self.accept("["): dims.append(self.expr()); self.expect("]")
                        ps.append((pt+"*"*pst,pn.value,bool(dims)))
                        if not self.accept(","):break
            self.expect(")"); b=self.stmt()
            if b.kind!="block":raise CompileError("Function body must be a block")
            return N("function",(typ+"*"*stars,name.value,ps),[b],name.line,name.col)
        d=self.decl(name,True,typ+"*"*stars); d.value=(typ+"*"*stars,d.value); return d
    def decl(self,name,top=False,typ="int"):
        dims=[]
        while self.accept("["):
            dims.append(self.expr()); self.expect("]")
        init=None
        if self.accept("="):
            if self.accept("{"):
                vals=[]
                if self.c.value!="}":
                    while True:
                        if self.accept("{"):
                            nested=[]
                            if self.c.value!="}":
                                while True:
                                    nested.append(self.expr())
                                    if not self.accept(","):break
                            self.expect("}"); vals.append(N("array_init",children=nested))
                        else: vals.append(self.expr())
                        if not self.accept(","):break
                        if self.c.value=="}":break
                self.expect("}"); init=N("array_init",children=vals)
            else:init=self.expr()
        if not top:self.expect(";")
        return N("declare",name.value,[N("dims",children=dims) if dims else None,init],name.line,name.col)
    def stmt(self):
        t=self.c
        if self.accept("{"):
            a=[]
            while self.c.value!="}":
                if self.c.kind=="EOF":raise CompileError("Unclosed block")
                a.append(self.stmt())
            self.expect("}");return N("block",children=a)
        if self.c.value in ("int","void","struct","union"):
            typ=self.type_spec(); stars=0
            while self.accept("*"): stars+=1
            name=self.take()
            if name.kind!="ID":raise CompileError("Expected variable name")
            d=self.decl(name,False,typ+"*"*stars);d.value=(typ+"*"*stars,d.value);return d
        if self.accept("if"):
            self.expect("(");c=self.expr();self.expect(")");y=self.stmt();n=self.stmt() if self.accept("else") else None
            return N("if",children=[c,y]+([n] if n else []))
        if self.accept("while"):
            self.expect("(");c=self.expr();self.expect(")");return N("while",children=[c,self.stmt()])
        if self.accept("for"):
            self.expect("(");i=None if self.c.value==";" else self.clause();self.expect(";")
            c=N("num",1) if self.c.value==";" else self.expr();self.expect(";")
            u=None if self.c.value==")" else self.clause();self.expect(")")
            return N("for",children=[i,c,u,self.stmt()])
        if self.accept("delete"):
            e=self.expr(); self.expect(";"); return N("delete",children=[e])
        if self.accept("return"):
            e=None if self.c.value==";" else self.expr();self.expect(";");return N("return",children=[e] if e else [])
        if self.accept("break"):self.expect(";");return N("break")
        if self.accept("continue"):self.expect(";");return N("continue")
        if self.c.value in ("print","printf"):
            f=self.take().value;self.expect("(");a=[]
            if self.c.value!=")":
                while True:
                    a.append(self.expr())
                    if not self.accept(","):break
            self.expect(")");self.expect(";");return N(f,children=a)
        if self.accept(";"):return N("empty")
        e=self.expr();self.expect(";")
        if e.kind=="assign_expr":return N("assign",e.value,e.children)
        if e.kind=="post":return N("incdec",e.value,e.children)
        return N("expr_stmt",children=[e])
    def clause(self):
        if self.c.value in ("int","void","struct","union"):
            typ=self.type_spec(); stars=0
            while self.accept("*"): stars+=1
            name=self.take()
            if name.kind!="ID":raise CompileError("Expected loop variable")
            d=self.decl(name,True,typ+"*"*stars);d.value=(typ+"*"*stars,d.value);return d
        e=self.expr()
        if e.kind=="assign_expr":return N("assign",e.value,e.children)
        if e.kind=="post":return N("incdec",e.value,e.children)
        return N("expr_stmt",children=[e])
    def expr(self,minp=1):
        x=self.unary()
        prec={"=":1,"+=":1,"-=":1,"*=":1,"/=":1,"%=":1,"||":2,"&&":3,"==":4,"!=":4,"<":4,"<=":4,">":4,">=":4,"+":5,"-":5,"*":6,"/":6,"%":6}
        while self.c.value in prec and prec[self.c.value]>=minp:
            o=self.take(); p=prec[o.value]; y=self.expr(p if o.value in ("=","+=","-=","*=","/=","%=") else p+1)
            if o.value in ("=","+=","-=","*=","/=","%="):
                if x.kind not in ("var","index","unary","field","arrow"):raise CompileError("Invalid assignment target")
                x=N("assign_expr",o.value,[x,y])
            else:x=N("bin",o.value,[x,y])
        return x
    def unary(self):
        if self.c.value=="sizeof":
            self.take(); self.expect("("); typ=self.type_spec(); stars=0
            while self.accept("*"): stars+=1
            self.expect(")")
            return N("sizeof",typ+"*"*stars)
        if self.c.value=="new":
            self.take(); typ=self.type_spec()
            if self.accept("["):
                count=self.expr(); self.expect("]"); return N("new_array",typ,[count])
            return N("new_object",typ)
        if self.c.value in ("-","+","!","&","*"):
            o=self.take();return N("unary",o.value,[self.unary()])
        x=self.primary()
        while True:
            if self.accept("["):
                ix=self.expr();self.expect("]");x=N("index",children=[x,ix])
            elif self.accept("."):
                f=self.take()
                if f.kind!="ID": raise CompileError("Expected field name")
                x=N("field",f.value,[x])
            elif self.accept("->"):
                f=self.take()
                if f.kind!="ID": raise CompileError("Expected field name")
                x=N("arrow",f.value,[x])
            elif self.accept("("):
                a=[]
                if self.c.value!=")":
                    while True:
                        a.append(self.expr())
                        if not self.accept(","):break
                self.expect(")")
                if x.kind!="var":raise CompileError("Only named function calls supported")
                x=N("call",x.value,a)
            elif self.c.value in ("++","--"):x=N("post",self.take().value,[x])
            else:break
        return x
    def primary(self):
        t=self.c
        if t.kind=="NUMBER":self.take();return N("num",int(t.value))
        if t.kind=="STRING":self.take();return N("str",bytes(t.value[1:-1],"utf-8").decode("unicode_escape"))
        if t.kind=="ID":self.take();return N("var",t.value)
        if self.accept("("):x=self.expr();self.expect(")");return x
        raise CompileError(f"Expected expression at {t.line}:{t.col}, got {t.value!r}")

def ast_text(n,d=0):
    label=n.kind+(f": {n.value}" if n.value is not None else "")
    return "\n".join(["  "*d+label]+[ast_text(c,d+1) for c in n.children if c is not None])

def check(ast):
    funcs={}; globals_={}; types={}
    for n in ast.children:
        if n.kind=="type_def":
            if n.value[1] in types: raise CompileError("Duplicate type "+n.value[1])
            types[n.value[1]]=n.value
        elif n.kind=="function":
            if n.value[1] in funcs:raise CompileError("Duplicate function "+n.value[1])
            funcs[n.value[1]]=n
        elif n.kind=="declare":
            nm=n.value[1]
            if nm in globals_:raise CompileError("Duplicate global "+nm)
            globals_[nm]=n
        else:raise CompileError("Only functions/global declarations allowed at file scope")
    def ex(n,scopes,loops):
        if n is None:return
        if n.kind=="var":
            if not any(n.value in s for s in scopes) and n.value not in globals_:raise CompileError("Undeclared variable "+n.value)
        elif n.kind=="call":
            if n.value not in funcs and n.value not in ("printf","print","malloc","free"):raise CompileError("Undefined function "+n.value)
            if n.value in funcs and len(n.children)!=len(funcs[n.value].value[2]):raise CompileError(f"{n.value}: wrong argument count")
            for c in n.children:ex(c,scopes,loops)
        elif n.kind in ("assign_expr",):
            ex(n.children[0],scopes,loops);ex(n.children[1],scopes,loops)
        else:
            for c in n.children:ex(c,scopes,loops)
    def st(n,scopes,loops):
        if n.kind=="block":
            scopes.append(set())
            for c in n.children:st(c,scopes,loops)
            scopes.pop()
        elif n.kind=="declare":
            nm=n.value[1]
            for c in n.children:
                if c:ex(c,scopes,loops)
            if nm in scopes[-1]:raise CompileError("Duplicate local variable "+nm)
            scopes[-1].add(nm)
        elif n.kind=="if":
            ex(n.children[0],scopes,loops);st(n.children[1],scopes,loops)
            if len(n.children)>2:st(n.children[2],scopes,loops)
        elif n.kind=="while":
            ex(n.children[0],scopes,loops);st(n.children[1],scopes,loops+1)
        elif n.kind=="for":
            scopes.append(set())
            i,c,u,b=n.children
            if i:st(i,scopes,loops)
            ex(c,scopes,loops)
            if u:st(u,scopes,loops)
            st(b,scopes,loops+1);scopes.pop()
        elif n.kind in ("break","continue"):
            if loops==0:raise CompileError(n.kind+" outside loop")
        elif n.kind=="return":
            for c in n.children:ex(c,scopes,loops)
        elif n.kind in ("print","printf","expr_stmt","incdec","assign"):
            for c in n.children:ex(c,scopes,loops)
    for f in funcs.values():
        ps=f.value[2]; names=[p[1] for p in ps]
        if len(set(names))!=len(names):raise CompileError("Duplicate parameter")
        st(f.children[0],[set(names)],0)
    return funcs,globals_,types

class UnionValue(dict):
    """All fields share one storage slot, as in a C union (simplified)."""
    def __init__(self, fields):
        super().__init__({name: 0 for name in fields})
        self._fields = set(fields)
        self._value = 0
    def __getitem__(self, key):
        if key not in self._fields: raise KeyError(key)
        return self._value
    def get(self, key, default=None):
        return self._value if key in self._fields else default
    def __setitem__(self, key, value):
        if key not in self._fields: raise KeyError(key)
        self._value = value

class Ret(Exception):
    def __init__(self,v):self.v=v
class Brk(Exception):pass
class Cont(Exception):pass

def calc(o,a,b):
    if o=="+":return a+b
    if o=="-":return a-b
    if o=="*":return a*b
    if o=="/":
        if not b:raise CompileError("Runtime error: division by zero")
        return int(a/b)
    if o=="%":
        if not b:raise CompileError("Runtime error: modulo by zero")
        return a%b
    if o=="&&":return int(bool(a) and bool(b))
    if o=="||":return int(bool(a) or bool(b))
    return {"==":int(a==b),"!=":int(a!=b),"<":int(a<b),"<=":int(a<=b),">":int(a>b),">=":int(a>=b)}[o]

def run(ast,max_steps=100000,max_depth=250):
    funcs,global_nodes,types=check(ast); glob={}; steps=[0]; heap={}; next_addr=[1000]
    class Ptr:
        def __init__(self, container, index=0, addr=None, cell=None): self.container=container; self.index=index; self.addr=addr; self.cell=cell
        def __repr__(self): return f"<ptr:{self.addr if self.addr is not None else id(self.container)}+{self.index}>"
    def make_record(typ):
        name=typ.split(" ",1)[1] if " " in typ else ""
        td=types.get(name)
        if not td:return {}
        kind,_,fields=td
        if kind=="union":return UnionValue([f[1] for f in fields])
        return {f[1]:0 for f in fields}
    def deref(p):
        if not isinstance(p,Ptr): raise CompileError("Runtime error: dereferencing non-pointer")
        if p.addr is not None and p.addr not in heap: raise CompileError("Runtime error: use-after-free or invalid pointer")
        if p.cell is not None: return p.cell[0][p.cell[1]]
        if not isinstance(p.container,list) or p.index<0 or p.index>=len(p.container): raise CompileError("Runtime error: invalid pointer access")
        return p.container[p.index]
    def ev(n,env,depth):
        if n.kind in ("num","str"):return n.value
        if n.kind=="sizeof":return 1  # one abstract memory cell per supported scalar
        if n.kind=="var":
            if n.value in env:return env[n.value]
            if n.value in glob:return glob[n.value]
            raise CompileError("Runtime undefined variable "+n.value)
        if n.kind=="index":
            a=ev(n.children[0],env,depth);i=ev(n.children[1],env,depth)
            if isinstance(a,Ptr):
                p=Ptr(a.container,a.index+i,a.addr); return deref(p)
            if not isinstance(a,list):raise CompileError("Indexing non-array")
            if not isinstance(i,int) or i<0 or i>=len(a):raise CompileError(f"Array index {i} out of bounds")
            return a[i]
        if n.kind=="field":
            obj=ev(n.children[0],env,depth)
            if not isinstance(obj,dict): raise CompileError("Field access on non-struct")
            return obj.get(n.value,0)
        if n.kind=="arrow":
            obj=deref(ev(n.children[0],env,depth))
            if not isinstance(obj,dict): raise CompileError("Arrow access on non-struct pointer")
            return obj.get(n.value,0)
        if n.kind=="new_array":
            count=ev(n.children[0],env,depth); count=max(0,min(int(count),100000)); arr=[0]*count; addr=next_addr[0];next_addr[0]+=1;heap[addr]=arr;return Ptr(arr,0,addr)
        if n.kind=="new_object":
            typ=n.value
            if typ.startswith("struct ") or typ.startswith("union "):
                obj=make_record(typ)
            else: obj=0
            arr=[obj]; addr=next_addr[0];next_addr[0]+=1;heap[addr]=arr;return Ptr(arr,0,addr)
        if n.kind=="call":
            args=[ev(c,env,depth) for c in n.children]
            if n.value in ("printf","print"):return builtin(n.value,args)
            if n.value=="malloc":
                count=max(1,int(args[0]) if args else 1); arr=[0]*min(count,100000); addr=next_addr[0];next_addr[0]+=1;heap[addr]=arr;return Ptr(arr,0,addr)
            if n.value=="free":
                if not args or args[0] == 0: return 0
                if not isinstance(args[0],Ptr) or args[0].addr is None:
                    raise CompileError("Runtime error: free requires a heap pointer or null")
                if args[0].addr not in heap: raise CompileError("Runtime error: double free")
                del heap[args[0].addr]
                return 0
            if n.value not in funcs:raise CompileError("Unknown function "+n.value)
            if depth>=max_depth:raise CompileError("Recursion depth limit exceeded")
            f=funcs[n.value];local={p[1]:v for p,v in zip(f.value[2],args)}
            try:st(f.children[0],local,depth+1)
            except Ret as r:return r.v
            return 0
        if n.kind=="unary":
            if n.value=="&": return address(n.children[0],env,depth)
            x=ev(n.children[0],env,depth)
            if n.value=="*": return deref(x)
            return -x if n.value=="-" else (int(not x) if n.value=="!" else x)
        if n.kind=="bin":
            x=ev(n.children[0],env,depth)
            if n.value=="&&" and not x:return 0
            if n.value=="||" and x:return 1
            y=ev(n.children[1],env,depth)
            if n.value in ("+","-") and isinstance(x,Ptr) and isinstance(y,int):
                if x.cell is not None and y != 0: raise CompileError("Runtime error: pointer arithmetic on scalar variables is not modeled")
                return Ptr(x.container,x.index+(y if n.value=="+" else -y),x.addr,x.cell)
            if n.value=="+" and isinstance(x,list) and isinstance(y,int): return Ptr(x,y)
            if n.value=="+" and isinstance(y,Ptr) and isinstance(x,int): return Ptr(y.container,y.index+x,y.addr,y.cell)
            if n.value=="-" and isinstance(x,Ptr) and isinstance(y,Ptr):
                if x.container is y.container and x.addr==y.addr: return x.index-y.index
                raise CompileError("Runtime error: subtracting unrelated pointers")
            return calc(n.value,x,y)
        if n.kind=="post":
            old=ev(n.children[0],env,depth); put(n.children[0],old+(1 if n.value=="++" else -1),env,depth);return old
        if n.kind=="assign_expr":
            t,r=n.children;v=ev(r,env,depth)
            if n.value!="=":v=calc(n.value[0],ev(t,env,depth),v)
            put(t,v,env,depth);return v
        raise CompileError("Unsupported expression "+n.kind)
    def address(t,env,depth):
        if t.kind=="var":
            if t.value in env: return Ptr([],0,cell=(env,t.value))
            if t.value in glob: return Ptr([],0,cell=(glob,t.value))
        if t.kind=="index":
            a=ev(t.children[0],env,depth);i=ev(t.children[1],env,depth)
            if isinstance(a,list) and 0<=i<len(a): return Ptr(a,i)
            if isinstance(a,Ptr): return Ptr(a.container,a.index+i,a.addr)
        if t.kind=="unary" and t.value=="*": return ev(t.children[0],env,depth)
        raise CompileError("Cannot take address of this expression")
    def put(t,v,env,depth):
        if t.kind=="var":
            if t.value in env:env[t.value]=v
            elif t.value in glob:glob[t.value]=v
            else:env[t.value]=v
        elif t.kind=="index":
            a=ev(t.children[0],env,depth);i=ev(t.children[1],env,depth)
            if isinstance(a,Ptr):
                p=Ptr(a.container,a.index+i,a.addr)
                if p.addr is not None and p.addr not in heap: raise CompileError("Runtime error: use-after-free")
                if p.index<0 or p.index>=len(p.container): raise CompileError("Invalid pointer index")
                p.container[p.index]=v; return
            if not isinstance(a,list):raise CompileError("Indexing non-array")
            if i<0 or i>=len(a):raise CompileError(f"Array index {i} out of bounds")
            a[i]=v
        elif t.kind=="unary" and t.value=="*":
            p=ev(t.children[0],env,depth)
            if not isinstance(p,Ptr): raise CompileError("Assignment through non-pointer")
            if p.addr is not None and p.addr not in heap: raise CompileError("Runtime error: use-after-free")
            if p.cell is not None: p.cell[0][p.cell[1]]=v
            else:
                if p.index<0 or p.index>=len(p.container): raise CompileError("Invalid pointer index")
                p.container[p.index]=v
        elif t.kind=="field":
            obj=ev(t.children[0],env,depth)
            if not isinstance(obj,dict): raise CompileError("Field assignment on non-struct")
            obj[t.value]=v
        elif t.kind=="arrow":
            obj=deref(ev(t.children[0],env,depth))
            if not isinstance(obj,dict): raise CompileError("Arrow assignment on non-struct")
            obj[t.value]=v
        else:raise CompileError("Invalid assignment target")
    def builtin(name,args):
        if name=="print":
            if args:print(args[0]);return args[0]
            return 0
        if not args:return 0
        fmt=args[0]; vals=args[1:]
        try: print(fmt % tuple(vals) if vals else fmt,end="")
        except (TypeError,ValueError):print(str(fmt),end="")
        return 0
    def st(n,env,depth):
        steps[0]+=1
        if steps[0]>max_steps:raise CompileError("Execution step limit exceeded")
        if n.kind in ("program","block"):
            for c in n.children:st(c,env,depth)
        elif n.kind=="declare":
            typ,name=n.value;dims_node,init=n.children
            dims=dims_node.children if dims_node else []
            def make_array(ds):
                if not ds:return 0
                z=ev(ds[0],env,depth)
                if not isinstance(z,int) or z<0 or z>100000:raise CompileError("Invalid array size")
                return [make_array(ds[1:]) for _ in range(z)]
            if dims:
                a=make_array(dims)
                def fill(dst,src):
                    if not isinstance(dst,list) or src.kind!="array_init": return
                    if len(src.children)>len(dst):raise CompileError("Too many array initializer values")
                    for i,e in enumerate(src.children):
                        if e.kind=="array_init":fill(dst[i],e)
                        else:dst[i]=ev(e,env,depth)
                if init:fill(a,init)
                env[name]=a
            elif init and init.kind=="array_init":raise CompileError("Initializer list requires array size")
            elif typ.startswith("struct ") or typ.startswith("union "):
                env[name]=make_record(typ)
                if init: env[name]=ev(init,env,depth)
            elif "*" in typ:
                pv=ev(init,env,depth) if init else 0
                env[name]=Ptr(pv,0) if isinstance(pv,list) else pv
            else:env[name]=ev(init,env,depth) if init else 0
        elif n.kind=="assign":
            target, rhs=n.children; value=ev(rhs,env,depth)
            if n.value!="=": value=calc(n.value[0],ev(target,env,depth),value)
            put(target,value,env,depth)
        elif n.kind=="if":
            if ev(n.children[0],env,depth):st(n.children[1],env,depth)
            elif len(n.children)>2:st(n.children[2],env,depth)
        elif n.kind=="while":
            while ev(n.children[0],env,depth):
                try:st(n.children[1],env,depth)
                except Cont:pass
                except Brk:break
        elif n.kind=="for":
            i,c,u,b=n.children
            if i:st(i,env,depth)
            while ev(c,env,depth):
                try:st(b,env,depth)
                except Cont:pass
                except Brk:break
                if u:st(u,env,depth)
        elif n.kind=="delete":
            p=ev(n.children[0],env,depth)
            if not isinstance(p,Ptr) or p.addr is None: raise CompileError("delete requires a heap pointer")
            if p.addr not in heap: raise CompileError("Runtime error: double free/delete")
            del heap[p.addr]
        elif n.kind=="return":raise Ret(ev(n.children[0],env,depth) if n.children else 0)
        elif n.kind=="break":raise Brk()
        elif n.kind=="continue":raise Cont()
        elif n.kind in ("print","printf"):builtin(n.kind,[ev(c,env,depth) for c in n.children])
        elif n.kind=="incdec":
            old=ev(n.children[0],env,depth);put(n.children[0],old+(1 if n.value=="++" else -1),env,depth)
        elif n.kind=="expr_stmt":ev(n.children[0],env,depth)
        elif n.kind=="empty":pass
    # globals
    for n in global_nodes.values():
        typ,name=n.value;dims_node,init=n.children
        dims=dims_node.children if dims_node else []
        def ga(ds):
            if not ds:return 0
            z=ev(ds[0],glob,0);return [ga(ds[1:]) for _ in range(z)]
        if dims: glob[name]=ga(dims)
        elif typ.startswith("struct ") or typ.startswith("union "):
            glob[name]=make_record(typ)
        elif "*" in typ:
            pv=ev(init,glob,0) if init else 0
            glob[name]=Ptr(pv,0) if isinstance(pv,list) else pv
        else:glob[name]=ev(init,glob,0) if init else 0
    if "main" in funcs:
        if funcs["main"].value[2]:raise CompileError("main parameters unsupported")
        try:st(funcs["main"].children[0],{},0)
        except Ret as r:return r.v,glob
    return 0,glob

def ir_listing(ast):
    out=[];idx=0
    def emit(op,*args):
        nonlocal idx;out.append(f"{idx:03}: {op} "+", ".join(map(str,args)));idx+=1
    def ex(n):
        if n is None:return
        if n.kind in ("num","str"):emit("CONST",repr(n.value))
        elif n.kind=="var":emit("LOAD",n.value)
        elif n.kind=="index":ex(n.children[0]);ex(n.children[1]);emit("ARRAY_LOAD")
        elif n.kind=="call":
            for c in n.children:ex(c)
            emit("CALL",n.value,len(n.children))
        elif n.kind=="bin":ex(n.children[0]);ex(n.children[1]);emit("BINARY",n.value)
        elif n.kind=="unary":ex(n.children[0]);emit("UNARY",n.value)
        elif n.kind=="assign_expr":ex(n.children[1]);emit("STORE",n.children[0].kind,n.value)
        elif n.kind=="post":emit("INCDEC",n.value)
    def st(n):
        if n.kind=="function":
            emit("FUNCTION",n.value[1],tuple(p[1] for p in n.value[2]));st(n.children[0]);emit("END_FUNCTION",n.value[1])
        elif n.kind in ("program","block"):
            for c in n.children:st(c)
        elif n.kind=="declare":
            emit("DECLARE",n.value[1],n.value[0])
            for c in n.children:
                if c:
                    if c.kind=="array_init":
                        for x in c.children:ex(x)
                        emit("ARRAY_INIT",n.value[1],len(c.children))
                    else:ex(c)
        elif n.kind=="assign":ex(n.children[1]);emit("ASSIGN",n.children[0].kind)
        elif n.kind in ("print","printf"):
            for c in n.children:ex(c)
            emit(n.kind.upper(),len(n.children))
        elif n.kind=="if":
            ex(n.children[0]);emit("IF");st(n.children[1])
            if len(n.children)>2:emit("ELSE");st(n.children[2])
            emit("ENDIF")
        elif n.kind in ("while","for"):
            emit("LOOP_BEGIN",n.kind)
            for c in n.children:
                if c:st(c) if c.kind in ("block","declare","assign","if","while","for","incdec","expr_stmt") else ex(c)
            emit("LOOP_END")
        elif n.kind=="return":
            if n.children:ex(n.children[0])
            emit("RETURN")
        elif n.kind in ("break","continue"):emit(n.kind.upper())
        elif n.kind=="incdec":ex(n.children[0]);emit("INCDEC",n.value)
        elif n.kind=="expr_stmt":ex(n.children[0])
    st(ast);return "\n".join(out)

@dataclass
class IROperand:
    kind: str
    value: object

@dataclass
class IRInstruction:
    id: int
    opcode: str
    type: str = "void"
    result: str | None = None
    operands: list = field(default_factory=list)
    predicate: str | None = None

@dataclass
class IRBlock:
    id: int
    label: str
    instrs: list = field(default_factory=list)

@dataclass
class IRFunction:
    name: str
    params: list
    blocks: list = field(default_factory=list)

@dataclass
class IRModule:
    functions: dict = field(default_factory=dict)

class IRUnsupported(Exception): pass

def ir_const(value): return IROperand("const", value)
def ir_value(value): return IROperand("value", value)
def ir_label(value): return IROperand("label", value)

class IRGenerator:
    """Small structured, LLVM-style IR builder for the scalar Mini-C subset."""
    def __init__(self):
        self.module=IRModule(); self.next_instr=0; self.next_block=0

    def generate(self, ast):
        for node in ast.children:
            if node.kind=="function": self.function(node)
            elif node.kind=="declare": raise IRUnsupported("global variables are not yet lowered to structured IR")
        return self.module

    def function(self, node):
        _, name, params=node.value
        if any(array for _,_,array in params): raise IRUnsupported("array parameters are not yet lowered to structured IR")
        self.fn=IRFunction(name,[p[1] for p in params]); self.module.functions[name]=self.fn
        self.slots={}; self.temp=0; self.current=self.block("entry")
        for _, param, _ in params:
            slot=self.declare(param, node.id if hasattr(node,"id") else None)
            self.emit("store", operands=[ir_value("%"+param), ir_value(slot)])
        self.stmt(node.children[0])
        if not self.terminated(): self.emit("ret", operands=[ir_const(0)])
        self.prune()

    def block(self, stem):
        suffix=sum(1 for b in self.fn.blocks if b.label.startswith(stem))
        block=IRBlock(self.next_block, stem if suffix==0 else f"{stem}.{suffix}")
        self.next_block+=1; self.fn.blocks.append(block); return block

    def emit(self, opcode, type="void", result=None, operands=None, predicate=None):
        ins=IRInstruction(self.next_instr,opcode,type,result,operands or [],predicate)
        self.next_instr+=1; self.current.instrs.append(ins); return ins

    def temp_name(self, hint="tmp"):
        name=f"%{hint}{self.temp}"; self.temp+=1; return name

    def terminated(self):
        return bool(self.current.instrs and self.current.instrs[-1].opcode in ("br","ret","unreachable"))

    def open_dead_block(self):
        if self.terminated(): self.current=self.block("dead")

    def declare(self, name, origin=None):
        if name in self.slots: raise IRUnsupported("shadowed variables are not lowered to structured IR")
        slot="%"+name+".addr"; self.slots[name]=slot
        self.emit("alloca","ptr",slot); return slot

    def expr(self, n):
        if n.kind=="num": return ir_const(n.value)
        if n.kind=="var":
            if n.value not in self.slots: raise IRUnsupported("global variable access is not yet lowered to structured IR")
            result=self.temp_name("load"); self.emit("load","i32",result,[ir_value(self.slots[n.value])]); return ir_value(result)
        if n.kind=="bin":
            left=self.expr(n.children[0]); right=self.expr(n.children[1]); op=n.value
            if op in ("+","-","*","/","%"):
                code={"+":"add","-":"sub","*":"mul","/":"sdiv","%":"srem"}[op]
                result=self.temp_name(code); self.emit(code,"i32",result,[left,right]); return ir_value(result)
            if op in ("==","!=","<","<=",">",">="):
                pred={"==":"eq","!=":"ne","<":"slt","<=":"sle",">":"sgt",">=":"sge"}[op]
                cmp=self.temp_name("cmp"); self.emit("icmp","i1",cmp,[left,right],pred)
                result=self.temp_name("zext"); self.emit("zext","i32",result,[ir_value(cmp)]); return ir_value(result)
            raise IRUnsupported(f"operator {op!r} is not yet lowered to structured IR")
        if n.kind=="unary":
            value=self.expr(n.children[0])
            if n.value=="-":
                result=self.temp_name("neg"); self.emit("sub","i32",result,[ir_const(0),value]); return ir_value(result)
            if n.value=="!":
                cmp=self.temp_name("not"); self.emit("icmp","i1",cmp,[value,ir_const(0)],"eq")
                result=self.temp_name("zext"); self.emit("zext","i32",result,[ir_value(cmp)]); return ir_value(result)
            raise IRUnsupported("pointer operations are not yet lowered to structured IR")
        if n.kind=="assign_expr": return self.assignment(n.value,n.children[0],n.children[1])
        if n.kind=="post":
            if n.children[0].kind!="var": raise IRUnsupported("only scalar variables support ++/-- in structured IR")
            name=n.children[0].value; old=self.expr(n.children[0]); result=self.temp_name("inc")
            self.emit("add" if n.value=="++" else "sub","i32",result,[old,ir_const(1)])
            self.emit("store",operands=[ir_value(result),ir_value(self.slots[name])]); return old
        if n.kind=="call":
            args=[self.expr(child) for child in n.children]; result=self.temp_name("call")
            self.emit("call","i32",result,[ir_value(n.value),*args]); return ir_value(result)
        raise IRUnsupported(f"expression {n.kind!r} is not yet lowered to structured IR")

    def assignment(self, op, target, rhs):
        if target.kind!="var" or target.value not in self.slots: raise IRUnsupported("only scalar local assignments are lowered to structured IR")
        value=self.expr(rhs)
        if op!="=":
            old=self.expr(target); result=self.temp_name("assign")
            self.emit({"+=":"add","-=":"sub","*=":"mul","/=":"sdiv","%=":"srem"}[op],"i32",result,[old,value]); value=ir_value(result)
        self.emit("store",operands=[value,ir_value(self.slots[target.value])]); return value

    def condition(self, n):
        value=self.expr(n)
        if value.kind=="const": return value
        result=self.temp_name("cond"); self.emit("icmp","i1",result,[value,ir_const(0)],"ne"); return ir_value(result)

    def stmt(self, n):
        if n.kind=="block":
            for child in n.children: self.open_dead_block(); self.stmt(child)
        elif n.kind=="declare":
            typ,name=n.value; dims,init=n.children
            if dims is not None or "*" in typ or typ.startswith(("struct ","union ")): raise IRUnsupported("only scalar int locals are lowered to structured IR")
            slot=self.declare(name); self.emit("store",operands=[self.expr(init) if init else ir_const(0),ir_value(slot)])
        elif n.kind=="assign": self.assignment(n.value,n.children[0],n.children[1])
        elif n.kind=="expr_stmt": self.expr(n.children[0])
        elif n.kind=="incdec": self.expr(N("post",n.value,n.children))
        elif n.kind=="return": self.emit("ret",operands=[self.expr(n.children[0])] if n.children else [])
        elif n.kind=="if":
            cond=self.condition(n.children[0]); then=self.block("if.then"); otherwise=self.block("if.else"); end=self.block("if.end")
            self.emit("br",operands=[cond,ir_label(then.id),ir_label(otherwise.id)])
            self.current=then; self.stmt(n.children[1]);
            if not self.terminated(): self.emit("br",operands=[ir_label(end.id)])
            self.current=otherwise
            if len(n.children)>2: self.stmt(n.children[2])
            if not self.terminated(): self.emit("br",operands=[ir_label(end.id)])
            self.current=end
        elif n.kind=="while":
            cond_block=self.block("while.cond"); body=self.block("while.body"); end=self.block("while.end")
            self.emit("br",operands=[ir_label(cond_block.id)]); self.current=cond_block
            self.emit("br",operands=[self.condition(n.children[0]),ir_label(body.id),ir_label(end.id)])
            self.current=body; self.stmt(n.children[1])
            if not self.terminated(): self.emit("br",operands=[ir_label(cond_block.id)])
            self.current=end
        elif n.kind=="for":
            init,cond,update,body_node=n.children
            if init: self.stmt(init)
            cond_block=self.block("for.cond"); body=self.block("for.body"); inc=self.block("for.inc"); end=self.block("for.end")
            self.emit("br",operands=[ir_label(cond_block.id)]); self.current=cond_block
            self.emit("br",operands=[self.condition(cond),ir_label(body.id),ir_label(end.id)])
            self.current=body; self.stmt(body_node)
            if not self.terminated(): self.emit("br",operands=[ir_label(inc.id)])
            self.current=inc
            if update: self.stmt(update)
            if not self.terminated(): self.emit("br",operands=[ir_label(cond_block.id)])
            self.current=end
        elif n.kind in ("empty",): pass
        else: raise IRUnsupported(f"statement {n.kind!r} is not yet lowered to structured IR")

    def prune(self):
        reachable={self.fn.blocks[0].id}; queue=list(reachable)
        while queue:
            block_id=queue.pop()
            block=next(b for b in self.fn.blocks if b.id==block_id)
            for ins in block.instrs:
                if ins.opcode=="br":
                    for op in ins.operands:
                        if op.kind=="label" and op.value not in reachable: reachable.add(op.value); queue.append(op.value)
        self.fn.blocks=[b for b in self.fn.blocks if b.id in reachable]

def clone_ir(module): return copy.deepcopy(module)

def operand_text(op):
    return str(op.value) if op.kind!="label" else "%"+str(op.value)

def print_ir(module):
    lines=[]
    for fn in module.functions.values():
        lines.append(f"define i32 @{fn.name}("+", ".join(f"i32 %{p}" for p in fn.params)+") {")
        for block in fn.blocks:
            lines.append(f"{block.label}:")
            for ins in block.instrs:
                prefix=(ins.result+" = ") if ins.result else ""
                if ins.opcode=="icmp": text=f"{prefix}icmp {ins.predicate} i32 "+", ".join(operand_text(x) for x in ins.operands)
                elif ins.opcode=="br":
                    text=(f"br label %{ins.operands[0].value}" if len(ins.operands)==1 else f"br i1 {operand_text(ins.operands[0])}, label %{ins.operands[1].value}, label %{ins.operands[2].value}")
                elif ins.opcode=="ret": text="ret void" if not ins.operands else "ret i32 "+operand_text(ins.operands[0])
                elif ins.opcode=="call": text=f"{prefix}call i32 @{ins.operands[0].value}("+", ".join("i32 "+operand_text(x) for x in ins.operands[1:])+")"
                elif ins.opcode=="alloca": text=f"{prefix}alloca i32"
                elif ins.opcode in ("load",): text=f"{prefix}load i32, ptr {operand_text(ins.operands[0])}"
                elif ins.opcode=="store": text=f"store i32 {operand_text(ins.operands[0])}, ptr {operand_text(ins.operands[1])}"
                elif ins.opcode=="zext": text=f"{prefix}zext i1 {operand_text(ins.operands[0])} to i32"
                else: text=f"{prefix}{ins.opcode} i32 "+", ".join(operand_text(x) for x in ins.operands)
                lines.append(f"  ; #{ins.id:03}  {text}")
        lines.append("}")
    return "\n".join(lines)

def all_instrs(fn): return [ins for block in fn.blocks for ins in block.instrs]
def replace_uses(fn, name, replacement):
    count=0
    for ins in all_instrs(fn):
        for i,op in enumerate(ins.operands):
            if op.kind=="value" and op.value==name: ins.operands[i]=copy.deepcopy(replacement); count+=1
    return count
def remove_ids(fn, ids):
    for block in fn.blocks: block.instrs=[ins for ins in block.instrs if ins.id not in ids]

def optimize_ir(module):
    """Mirror the web project's fixed, conservative pass order on a clone."""
    work=clone_ir(module); changes=[]
    for fn in work.functions.values():
        # 1. Block-local store/load forwarding.
        for block in fn.blocks:
            known={}; remove=set()
            for ins in block.instrs:
                if ins.opcode=="store": known[ins.operands[1].value]=ins.operands[0]
                elif ins.opcode=="call": known.clear()
                elif ins.opcode=="load" and ins.operands[0].value in known:
                    uses=replace_uses(fn,ins.result,known[ins.operands[0].value]); remove.add(ins.id); changes.append(("forwarding",ins.id,f"forwarded {uses} use(s)"))
            remove_ids(fn,remove)
        # 2. Constant and branch folding, to a fixpoint.
        for _ in range(64):
            progress=False
            for block in fn.blocks:
                remove=set()
                for ins in block.instrs:
                    vals=[op.value for op in ins.operands if op.kind=="const"]
                    value=None
                    if ins.opcode in ("add","sub","mul","sdiv","srem") and len(vals)==2:
                        a,b=vals; value={"add":lambda:a+b,"sub":lambda:a-b,"mul":lambda:a*b,"sdiv":lambda:int(a/b) if b else 0,"srem":lambda:a%b if b else 0}[ins.opcode](); value=((value+2**31)%2**32)-2**31
                    elif ins.opcode=="icmp" and len(vals)==2:
                        a,b=vals; value=int({"eq":a==b,"ne":a!=b,"slt":a<b,"sle":a<=b,"sgt":a>b,"sge":a>=b}[ins.predicate])
                    elif ins.opcode=="zext" and len(vals)==1: value=int(bool(vals[0]))
                    elif ins.opcode=="br" and len(ins.operands)==3 and ins.operands[0].kind=="const":
                        ins.operands=[ins.operands[1] if ins.operands[0].value else ins.operands[2]]; changes.append(("folding",ins.id,"folded constant branch")); progress=True; continue
                    if value is not None and ins.result:
                        uses=replace_uses(fn,ins.result,ir_const(value)); remove.add(ins.id); changes.append(("folding",ins.id,f"folded to {value} ({uses} use(s))")); progress=True
                remove_ids(fn,remove)
            if not progress: break
        # 3. Block-local common-subexpression elimination.
        for block in fn.blocks:
            seen={}; remove=set()
            for ins in block.instrs:
                if ins.opcode not in ("add","sub","mul","sdiv","srem","icmp","zext") or not ins.result: continue
                key=(ins.opcode,ins.predicate,tuple((op.kind,op.value) for op in ins.operands))
                if key in seen:
                    uses=replace_uses(fn,ins.result,ir_value(seen[key])); remove.add(ins.id); changes.append(("cse",ins.id,f"reused {seen[key]} ({uses} use(s))"))
                else: seen[key]=ins.result
            remove_ids(fn,remove)
        # 4. Dead-code elimination to a fixpoint.
        for _ in range(64):
            used={op.value for ins in all_instrs(fn) for op in ins.operands if op.kind=="value"}; remove={ins.id for ins in all_instrs(fn) if ins.result and ins.result not in used and ins.opcode in ("load","add","sub","mul","sdiv","srem","icmp","zext")}
            if not remove: break
            for ins in all_instrs(fn):
                if ins.id in remove: changes.append(("dce",ins.id,"removed unused pure value"))
            remove_ids(fn,remove)
    return work,changes

def verify_ir(module):
    for fn in module.functions.values():
        ids={block.id for block in fn.blocks}
        for block in fn.blocks:
            if not block.instrs or block.instrs[-1].opcode not in ("br","ret","unreachable"): return f"block {block.label} has no terminator"
            for ins in block.instrs:
                for op in ins.operands:
                    if op.kind=="label" and op.value not in ids: return f"branch targets missing block {op.value}"
    return None

def assembly_from_ir(module):
    out=["; Illustrative x86-64 assembly lowered from this compiler's IR.","; Text only — never assembled or executed."]
    for fn in module.functions.values():
        out.extend([f"{fn.name}:","  push rbp","  mov rbp, rsp"])
        for block in fn.blocks:
            out.append(f".L{fn.name}.{block.label}:")
            for ins in block.instrs:
                op=ins.opcode
                if op=="add": out.append("  add eax, edx")
                elif op=="sub": out.append("  sub eax, edx")
                elif op=="mul": out.append("  imul eax, edx")
                elif op in ("sdiv","srem"): out.extend(["  cdq","  idiv ecx"])
                elif op=="icmp": out.extend(["  cmp eax, edx",f"  set{ {'eq':'e','ne':'ne','slt':'l','sle':'le','sgt':'g','sge':'ge'}[ins.predicate] } al"])
                elif op=="br": out.append(f"  jmp .L{fn.name}.{next(b.label for b in fn.blocks if b.id==ins.operands[-1].value)}")
                elif op=="call": out.append(f"  call {ins.operands[0].value}")
                elif op=="ret": out.append("  ret")
                else: out.append(f"  ; {op}")
    return "\n".join(out)

def execute_ir(module, function="main", args=None, depth=0):
    """Educational interpreter for the same scalar IR shown in stages 5–7."""
    if depth>250: raise CompileError("Recursion depth limit exceeded")
    if function not in module.functions: raise CompileError("IR runtime: unknown function "+function)
    fn=module.functions[function]; values={"%"+name:value for name,value in zip(fn.params,args or [])}; memory={}
    block_by_id={block.id:block for block in fn.blocks}; block=fn.blocks[0]; index=0
    def value(op):
        if op.kind=="const": return op.value
        if op.kind=="value": return values.get(op.value,0)
        raise CompileError("IR runtime: invalid value operand")
    while True:
        if index>=len(block.instrs): raise CompileError("IR runtime: block has no terminator")
        ins=block.instrs[index]; index+=1; op=ins.opcode
        if op=="alloca": memory[ins.result]=0; values[ins.result]=ins.result
        elif op=="store": memory[value(ins.operands[1])]=value(ins.operands[0])
        elif op=="load": values[ins.result]=memory[value(ins.operands[0])]
        elif op in ("add","sub","mul","sdiv","srem"):
            a,b=value(ins.operands[0]),value(ins.operands[1])
            result={"add":a+b,"sub":a-b,"mul":a*b,"sdiv":int(a/b) if b else 0,"srem":a%b if b else 0}[op]
            values[ins.result]=((result+2**31)%2**32)-2**31
        elif op=="icmp":
            a,b=value(ins.operands[0]),value(ins.operands[1]); values[ins.result]=int({"eq":a==b,"ne":a!=b,"slt":a<b,"sle":a<=b,"sgt":a>b,"sge":a>=b}[ins.predicate])
        elif op=="zext": values[ins.result]=int(bool(value(ins.operands[0])))
        elif op=="call": values[ins.result]=execute_ir(module,ins.operands[0].value,[value(arg) for arg in ins.operands[1:]],depth+1)
        elif op=="br":
            target=ins.operands[0] if len(ins.operands)==1 else ins.operands[1 if value(ins.operands[0]) else 2]
            block=block_by_id[target.value]; index=0
        elif op=="ret": return value(ins.operands[0]) if ins.operands else 0
        elif op=="unreachable": raise CompileError("IR runtime reached unreachable instruction")
        else: raise CompileError("IR runtime: unsupported opcode "+op)

def normalize(src):
    return "\n".join(l for l in src.splitlines() if not l.strip().startswith(("#include","#define")) and not re.match(r"\s*using\s+namespace\s+std\s*;",l))

def pipeline(src):
    src=normalize(src);tokens=lex(src);ast=Parser(tokens).parse();check(ast)
    structured=None; optimized=None; changes=[]; ir_error=None
    try:
        structured=IRGenerator().generate(ast)
        ir_error=verify_ir(structured)
        if ir_error: raise CompileError("generated invalid IR: "+ir_error)
        optimized,changes=optimize_ir(structured)
        ir_error=verify_ir(optimized)
        if ir_error: raise CompileError("optimizer produced invalid IR: "+ir_error)
    except IRUnsupported as e:
        ir_error=str(e)
    print("="*68+"\n1. SOURCE\n"+"="*68+"\n"+src)
    print("\n2. LEXICAL\n"+"\n".join(f"{t.kind:<8} {t.value!r}" for t in tokens if t.kind!="EOF"))
    print("\n3. SYNTAX (AST)\n"+ast_text(ast))
    print("\n4. SEMANTICS\nPassed: declarations, calls, and loop-control checks.")
    if structured is None:
        ir=ir_listing(ast)
        print("\n5. IR\nLegacy listing (structured IR is available for scalar Mini-C programs):\n"+ir)
        print("\n6. OPTIMIZE\nSkipped: "+ir_error+"\n"+ir)
        print("\n7. ASSEMBLY\n; explanatory legacy pseudo-assembly\n"+"\n".join("; "+x for x in ir.splitlines()))
    else:
        print("\n5. IR (O0 LLVM-style)\n"+print_ir(structured))
        change_text="\n".join(f"- {name}: instruction #{ident:03} {detail}" for name,ident,detail in changes) or "No safe transformations were applicable."
        print("\n6. OPTIMIZE\nPass order: forwarding -> folding -> CSE -> DCE\n"+change_text+"\n\nOptimized IR:\n"+print_ir(optimized))
        print("\n7. ASSEMBLY\n"+assembly_from_ir(structured))
    print("\n8. EXECUTION")
    if structured is None:
        result,globals_=run(ast); print(f"Compatibility AST interpreter\n\nProgram return value: {result}\nGlobals: {globals_}")
    else:
        result=execute_ir(structured); print(f"IR simulator\n\nProgram return value: {result}\nGlobals: {{}}")

class Tests(unittest.TestCase):
    def runsrc(self,src):
        ast=Parser(lex(normalize(src))).parse();check(ast);return run(ast)[0]
    def test_factorial_recursion(self):
        self.assertEqual(self.runsrc("int fact(int n){if(n<=1)return 1;return n*fact(n-1);} int main(){printf(\"%d\\\\n\",fact(5));return 0;}"),0)
    def test_array_sum(self):
        self.assertEqual(self.runsrc("int main(){int a[5]={1,2,3,4,5};int s=0;for(int i=0;i<5;i++){s+=a[i];}printf(\"%d\\\\n\",s);return 0;}"),0)
    def test_array_assignment(self):
        self.assertEqual(self.runsrc("int main(){int a[3]={0,0,0};a[1]=7;printf(\"%d\\\\n\",a[1]);return 0;}"),0)
    def test_break_continue(self):
        self.assertEqual(self.runsrc("int main(){int s=0;for(int i=0;i<6;i++){if(i==2)continue;if(i==5)break;s+=i;}return 0;}"),0)
    def test_arithmetic(self):
        self.assertEqual(self.runsrc("int main(){int x=2+3*4;return x;}"),14)
    def test_compound_assignment_loop(self):
        self.assertEqual(self.runsrc("int main(){int s=0;for(int i=0;i<5;i++)s+=i;return s;}"),10)
    def test_bounds(self):
        with self.assertRaises(CompileError):self.runsrc("int main(){int a[2];printf(\"%d\",a[3]);return 0;}")

    def test_multidimensional_array(self):
        self.assertEqual(self.runsrc("int main(){int a[2][2]={{1,2},{3,4}};return a[1][0];}"),3)
    def test_pointer_and_malloc(self):
        self.assertEqual(self.runsrc("int main(){int *p=malloc(3);p[1]=9;int x=p[1];free(p);return x;}"),9)
    def test_struct(self):
        self.assertEqual(self.runsrc("struct Point { int x; int y; }; int main(){struct Point p;p.x=4;p.y=6;return p.x+p.y;}"),10)
    def test_address_deref(self):
        self.assertEqual(self.runsrc("int main(){int x=3;int *p=&x;*p=8;return x;}"),8)
    def test_cpp_new_delete(self):
        self.assertEqual(self.runsrc("int main(){int *p=new int[2];p[0]=6;int x=p[0];delete p;return x;}"),6)
    def test_pointer_arithmetic(self):
        self.assertEqual(self.runsrc("int main(){int a[3]={4,7,9};int *p=a;p=p+1;return *p;}"),7)
    def test_pointer_difference(self):
        self.assertEqual(self.runsrc("int main(){int a[3]={1,2,3};int *p=a;int *q=a+2;return q-p;}"),2)
    def test_struct_pointer_arrow(self):
        self.assertEqual(self.runsrc("struct Point {int x;}; int main(){struct Point p;struct Point *q=&p;q->x=12;return p.x;}"),12)
    def test_union_shared_storage(self):
        self.assertEqual(self.runsrc("union U {int x;int y;}; int main(){union U u;u.x=13;return u.y;}"),13)
    def test_malloc_sizeof_and_free_errors(self):
        self.assertEqual(self.runsrc("int main(){int *p=malloc(3*sizeof(int));p[2]=17;int x=p[2];free(p);return x;}"),17)
    def test_double_free_detected(self):
        with self.assertRaises(CompileError): self.runsrc("int main(){int *p=malloc(2);free(p);free(p);return 0;}")
    def test_use_after_free_detected(self):
        with self.assertRaises(CompileError): self.runsrc("int main(){int *p=malloc(2);free(p);return p[0];}")

    def test_positional_file_mode_reads_source(self):
        source = "int main(){return 42;}"
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".c", delete=False) as f:
            f.write(source)
            path = f.name
        try:
            args = parse_args([path])
            self.assertEqual(read_source(args), source)
        finally:
            import os
            os.unlink(path)

    def test_terminal_menu_code_mode_stops_at_end_sentinel(self):
        args = parse_args([])
        source = read_source(args, stdin=io.StringIO("1\nint main(){\nreturn 7;\n}\nEND\nignored\n"), stderr=io.StringIO())
        self.assertEqual(source, "int main(){\nreturn 7;\n}\n")

    def test_terminal_menu_code_mode_accepts_end_of_input(self):
        args = parse_args([])
        source = read_source(args, stdin=io.StringIO("1\nint main(){return 3;}\n"), stderr=io.StringIO())
        self.assertEqual(source, "int main(){return 3;}\n")

    def test_terminal_menu_file_mode_reads_selected_path(self):
        source = "int main(){return 11;}"
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".c", delete=False) as f:
            f.write(source)
            path = f.name
        try:
            args = parse_args([])
            self.assertEqual(read_source(args, stdin=io.StringIO(f"2\n{path}\n"), stderr=io.StringIO()), source)
        finally:
            os.unlink(path)

    def structured_ir(self, source):
        ast=Parser(lex(normalize(source))).parse(); check(ast)
        module=IRGenerator().generate(ast)
        self.assertIsNone(verify_ir(module))
        return module

    def test_structured_ir_executes_recursive_functions(self):
        module=self.structured_ir("int fact(int n){if(n<=1)return 1;return n*fact(n-1);} int main(){return fact(5);}")
        self.assertEqual(execute_ir(module),120)

    def test_optimizer_clones_and_folds_structured_ir(self):
        module=self.structured_ir("int main(){int x=2+3;return x;}")
        optimized,changes=optimize_ir(module)
        self.assertIsNot(module,optimized)
        self.assertTrue(any(name=="folding" for name,_,_ in changes))
        self.assertIsNone(verify_ir(optimized))
        self.assertEqual(execute_ir(optimized),5)


def parse_args(argv=None):
    ap=argparse.ArgumentParser(description="Mini-C compiler subset with functions, recursion, and arrays")
    ap.add_argument("source", nargs="?", help="source file (.c/.cpp subset)")
    ap.add_argument("--file", dest="file", help="source file (.c/.cpp subset); compatibility alias")
    ap.add_argument("--test",action="store_true",help="run built-in tests")
    a=ap.parse_args(argv)
    if a.source and a.file:
        ap.error("provide a source path either positionally or with --file, not both")
    return a


def read_interactive_source(stdin=sys.stdin, stderr=sys.stderr):
    """Read a complete Mini-C program until END alone on a line or EOF."""
    print("Paste your Mini-C program. Enter END on a line by itself to compile, or end input with Ctrl+D/Ctrl+Z.", file=stderr)
    lines=[]
    for line in stdin:
        if line.rstrip("\r\n") == "END":
            break
        lines.append(line)
    source="".join(lines)
    if not source.strip():
        raise CompileError("No source code received")
    return source


def choose_source_interactively(stdin=sys.stdin, stderr=sys.stderr):
    """Show the terminal menu used when no command-line source path is given."""
    print("Mini-C Compiler", file=stderr)
    print("1) Write or paste code in the terminal", file=stderr)
    print("2) Read code from a source file", file=stderr)
    while True:
        print("Choose an option (1 or 2): ", end="", flush=True, file=stderr)
        choice=stdin.readline()
        if not choice:
            raise CompileError("No input mode selected")
        choice=choice.strip()
        if choice=="1":
            return read_interactive_source(stdin, stderr)
        if choice=="2":
            print("Source file path [code.c]: ", end="", flush=True, file=stderr)
            path=stdin.readline().strip() or "code.c"
            with open(path, encoding="utf-8") as source_file:
                return source_file.read()
        print("Please enter 1 or 2.", file=stderr)


def read_source(args, stdin=sys.stdin, stderr=sys.stderr):
    path=args.source or args.file
    if path:
        with open(path, encoding="utf-8") as source_file:
            return source_file.read()
    return choose_source_interactively(stdin, stderr)

def main():
    a=parse_args()
    if a.test:
        r=unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(Tests));return 0 if r.wasSuccessful() else 1
    try:pipeline(read_source(a));return 0
    except (CompileError,OSError,IndexError) as e:print("\nERROR:",e,file=sys.stderr);return 1

if __name__=="__main__":raise SystemExit(main())
