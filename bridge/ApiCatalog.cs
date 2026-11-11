using System;
using System.Linq;
using System.Collections.Generic;
using System.Reflection;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace RevitWorkspace {
    // Metadata only. Never invokes API members or reads a Document; callable off the UI thread.
    public static class ApiCatalog {
        private static readonly Assembly[] assemblies = { typeof(Document).Assembly, typeof(UIApplication).Assembly };
        private static readonly Lazy<Type[]> types = new Lazy<Type[]>(() => assemblies.SelectMany(LoadTypes).ToArray());
        private static IEnumerable<Type> LoadTypes(Assembly assembly) {
            try { return assembly.GetExportedTypes(); }
            catch(ReflectionTypeLoadException ex) { return ex.Types.Where(t=>t!=null && t.IsPublic); }
        }
        private static string Name(Type type) {
            if (type.IsByRef) return Name(type.GetElementType())+"&";
            if (type.IsArray) return Name(type.GetElementType())+"[]";
            if (type.IsGenericType) return (type.GetGenericTypeDefinition().FullName??type.Name).Split('`')[0]+"<"+string.Join(", ",type.GetGenericArguments().Select(Name))+">";
            return type.FullName??type.Name;
        }
        private static string Obsolete(MemberInfo member) {
            var attribute = member.GetCustomAttributesData().FirstOrDefault(a=>a.AttributeType==typeof(ObsoleteAttribute));
            return attribute==null?null:attribute.ConstructorArguments.Count>0?Convert.ToString(attribute.ConstructorArguments[0].Value):"Obsolete";
        }
        private static object Parameter(ParameterInfo p) {
            return new {name=p.Name,type=Name(p.ParameterType),isOut=p.IsOut,optional=p.IsOptional,
                defaultValue=p.IsOptional?Convert.ToString(p.DefaultValue):null};
        }
        private static string Arguments(MethodBase m) {
            return string.Join(", ",m.GetParameters().Select(p=>(p.IsOut?"out ":p.ParameterType.IsByRef?"ref ":"")+Name(p.ParameterType)+" "+p.Name+(p.IsOptional?" = "+Convert.ToString(p.DefaultValue):"")));
        }
        private static object Describe(MemberInfo member) {
            var method=member as MethodInfo;var constructor=member as ConstructorInfo;
            if(method!=null)return new {kind="method",name=method.Name,isStatic=method.IsStatic,declaringType=Name(method.DeclaringType),
                signature=Name(method.ReturnType)+" "+method.Name+"("+Arguments(method)+")",returnType=Name(method.ReturnType),
                parameters=method.GetParameters().Select(Parameter).ToArray(),obsolete=Obsolete(method)};
            if(constructor!=null)return new {kind="constructor",name=constructor.DeclaringType.Name,isStatic=false,
                signature=Name(constructor.DeclaringType)+"("+Arguments(constructor)+")",parameters=constructor.GetParameters().Select(Parameter).ToArray(),obsolete=Obsolete(constructor)};
            var property=member as PropertyInfo;
            if(property!=null)return new {kind="property",name=property.Name,type=Name(property.PropertyType),
                canRead=property.CanRead,canWrite=property.CanWrite,isStatic=(property.GetGetMethod()??property.GetSetMethod()).IsStatic,
                declaringType=Name(property.DeclaringType),signature=Name(property.PropertyType)+" "+property.Name,obsolete=Obsolete(property)};
            var field=member as FieldInfo;
            if(field!=null)return new {kind="field",name=field.Name,type=Name(field.FieldType),isStatic=field.IsStatic,
                value=field.IsLiteral?Convert.ToString(field.GetRawConstantValue()):null,signature=Name(field.FieldType)+" "+field.Name,obsolete=Obsolete(field)};
            var ev=member as EventInfo;
            if(ev!=null)return new {kind="event",name=ev.Name,type=Name(ev.EventHandlerType),signature=Name(ev.EventHandlerType)+" "+ev.Name,obsolete=Obsolete(ev)};
            return new {kind=member.MemberType.ToString(),name=member.Name,signature=member.Name};
        }
        private static int Distance(string a,string b) {
            a=a.ToLowerInvariant();b=b.ToLowerInvariant();var row=Enumerable.Range(0,b.Length+1).ToArray();
            for(int i=1;i<=a.Length;i++){int previous=row[0];row[0]=i;for(int j=1;j<=b.Length;j++){int old=row[j];row[j]=Math.Min(Math.Min(row[j]+1,row[j-1]+1),previous+(a[i-1]==b[j-1]?0:1));previous=old;}}
            return row[b.Length];
        }
        private static Type[] Resolve(string name) { return types.Value.Where(t=>string.Equals(t.FullName,name,StringComparison.OrdinalIgnoreCase)||string.Equals(t.Name,name,StringComparison.OrdinalIgnoreCase)).ToArray(); }
        public static object Lookup(string query,int offset,int limit) {
            if(string.IsNullOrWhiteSpace(query)||query.Length>200)throw new ArgumentException("API name must be 1..200 characters");
            query=query.Trim();offset=Math.Max(0,Math.Min(10000,offset));limit=Math.Max(1,Math.Min(100,limit==0?50:limit));
            var matches=Resolve(query);string memberName=null;
            if(matches.Length==0 && query.Contains(".")){int split=query.LastIndexOf('.');matches=Resolve(query.Substring(0,split));memberName=query.Substring(split+1);}
            if(matches.Length==0){string needle=query.Split('.').Last();return new {found=false,query=query,
                suggestions=types.Value.OrderBy(t=>Distance(needle,t.Name)).ThenBy(t=>t.FullName,StringComparer.Ordinal).Take(10).Select(t=>t.FullName).ToArray()};}
            if(matches.Length>1)return new {found=false,ambiguous=true,query=query,matches=matches.Take(40).Select(t=>t.FullName).ToArray()};
            var type=matches[0];var flags=BindingFlags.Public|BindingFlags.Instance|BindingFlags.Static;
            var all=type.GetMembers(flags).Where(m=>m is PropertyInfo || m is FieldInfo || m is ConstructorInfo || m is EventInfo || (m is MethodInfo && !((MethodInfo)m).IsSpecialName)).ToArray();
            var members=all.Where(m=>memberName==null||string.Equals(m.Name,memberName,StringComparison.OrdinalIgnoreCase))
                .OrderBy(m=>m.Name,StringComparer.Ordinal).ThenBy(m=>m.ToString(),StringComparer.Ordinal).ToArray();
            return new {found=memberName==null||members.Length>0,query=query,type=type.FullName,kind=type.IsEnum?"enum":type.IsInterface?"interface":type.IsValueType?"struct":"class",
                baseType=type.BaseType==null?null:Name(type.BaseType),obsolete=Obsolete(type),
                source=new {assembly=type.Assembly.GetName().Name,version=type.Assembly.GetName().Version.ToString(),path=type.Assembly.Location,mvid=type.Assembly.ManifestModule.ModuleVersionId.ToString()},
                totalMembers=members.Length,members=members.Skip(offset).Take(limit).Select(Describe).ToArray(),
                nextOffset=offset+limit<members.Length?(int?)(offset+limit):null,
                suggestions=members.Length==0?all.Select(m=>m.Name).Distinct().OrderBy(n=>Distance(memberName??"",n)).Take(10).ToArray():new string[0]};
        }
    }
}
